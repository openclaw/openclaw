import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandTemplateVariables,
  findTemplate,
  loadTemplates,
  resolveTemplateContent,
  templatesAddCommand,
  templatesListCommand,
  templatesRemoveCommand,
  templatesShowCommand,
  templatesUpdateCommand,
  type ResponseTemplate,
} from "./templates.js";

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    exit: (code: number) => {
      throw new Error(`exit(${code})`);
    },
    logs,
    errors,
  };
}

describe("expandTemplateVariables", () => {
  it("expands built-in date variables", () => {
    const result = expandTemplateVariables("Today is {date}");
    expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
  });

  it("expands custom variables", () => {
    const result = expandTemplateVariables("Hello {senderName}!", { senderName: "Alice" });
    expect(result).toBe("Hello Alice!");
  });

  it("leaves unresolved variables as-is", () => {
    const result = expandTemplateVariables("Hello {unknown}!");
    expect(result).toBe("Hello {unknown}!");
  });

  it("handles multiple variables", () => {
    const result = expandTemplateVariables("{greeting} {name}, today is {date}", {
      greeting: "Hi",
      name: "Bob",
    });
    expect(result).toMatch(/Hi Bob, today is \d{4}-\d{2}-\d{2}/);
  });
});

describe("findTemplate", () => {
  const templates: ResponseTemplate[] = [
    {
      id: "greeting",
      name: "Welcome Greeting",
      content: "Hello!",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "away",
      name: "Away Message",
      content: "I am away.",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];

  it("finds by exact id", () => {
    expect(findTemplate(templates, "greeting")?.id).toBe("greeting");
  });

  it("finds by case-insensitive name", () => {
    expect(findTemplate(templates, "away message")?.id).toBe("away");
  });

  it("returns undefined for non-existent template", () => {
    expect(findTemplate(templates, "nonexistent")).toBeUndefined();
  });
});

describe("resolveTemplateContent", () => {
  it("returns default content when no channel override", () => {
    const template: ResponseTemplate = {
      id: "test",
      name: "Test",
      content: "Default content",
      createdAt: "",
      updatedAt: "",
    };
    expect(resolveTemplateContent(template)).toBe("Default content");
    expect(resolveTemplateContent(template, "telegram")).toBe("Default content");
  });

  it("returns channel-specific content when available", () => {
    const template: ResponseTemplate = {
      id: "test",
      name: "Test",
      content: "Default",
      channels: { telegram: "Telegram version", discord: "Discord version" },
      createdAt: "",
      updatedAt: "",
    };
    expect(resolveTemplateContent(template, "telegram")).toBe("Telegram version");
    expect(resolveTemplateContent(template, "discord")).toBe("Discord version");
    expect(resolveTemplateContent(template, "slack")).toBe("Default");
  });
});

describe("templates CLI commands", () => {
  let tmpDir: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-templates-test-"));
    origEnv = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (origEnv !== undefined) {
      process.env.CLAWDBOT_STATE_DIR = origEnv;
    } else {
      delete process.env.CLAWDBOT_STATE_DIR;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists empty templates", async () => {
    const runtime = createRuntime();
    await templatesListCommand({}, runtime);
    expect(runtime.logs.some((l) => l.includes("No response templates"))).toBe(true);
  });

  it("adds a template", async () => {
    const runtime = createRuntime();
    await templatesAddCommand(
      { id: "greet", name: "Greeting", content: "Hello {name}!" },
      runtime,
    );
    expect(runtime.logs.some((l) => l.includes("added"))).toBe(true);

    const templates = loadTemplates(tmpDir);
    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe("greet");
    expect(templates[0].variables).toEqual(["name"]);
  });

  it("prevents duplicate ids", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Greeting", content: "Hello!" }, runtime);

    const runtime2 = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Another", content: "Hi!" }, runtime2);
    expect(runtime2.errors.some((l) => l.includes("already exists"))).toBe(true);
  });

  it("removes a template", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Greeting", content: "Hello!" }, runtime);
    await templatesRemoveCommand({ id: "greet" }, runtime);
    expect(runtime.logs.some((l) => l.includes("removed"))).toBe(true);

    const templates = loadTemplates(tmpDir);
    expect(templates).toHaveLength(0);
  });

  it("shows a template", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Greeting", content: "Hello {name}!" }, runtime);

    const runtime2 = createRuntime();
    await templatesShowCommand({ id: "greet" }, runtime2);
    expect(runtime2.logs.some((l) => l.includes("Hello {name}!"))).toBe(true);
  });

  it("shows template with expansion", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Greeting", content: "Hello {name}!" }, runtime);

    const runtime2 = createRuntime();
    await templatesShowCommand({ id: "greet", expand: true, vars: "name=Alice" }, runtime2);
    expect(runtime2.logs.some((l) => l.includes("Hello Alice!"))).toBe(true);
  });

  it("updates a template", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "greet", name: "Greeting", content: "Hello!" }, runtime);
    await templatesUpdateCommand({ id: "greet", content: "Hi there!" }, runtime);

    const templates = loadTemplates(tmpDir);
    expect(templates[0].content).toBe("Hi there!");
  });

  it("lists templates as JSON", async () => {
    const runtime = createRuntime();
    await templatesAddCommand({ id: "t1", name: "Template 1", content: "Content 1" }, runtime);
    await templatesAddCommand({ id: "t2", name: "Template 2", content: "Content 2" }, runtime);

    const runtime2 = createRuntime();
    await templatesListCommand({ json: true }, runtime2);
    const output = JSON.parse(runtime2.logs.join("\n"));
    expect(output.count).toBe(2);
  });

  it("filters templates by agent", async () => {
    const runtime = createRuntime();
    await templatesAddCommand(
      { id: "t1", name: "For Pi", content: "Pi only", agents: "pi" },
      runtime,
    );
    await templatesAddCommand({ id: "t2", name: "For All", content: "Everyone" }, runtime);

    const runtime2 = createRuntime();
    await templatesListCommand({ json: true, agent: "pi" }, runtime2);
    const output = JSON.parse(runtime2.logs.join("\n"));
    expect(output.count).toBe(2); // both: t1 has pi, t2 has no agent restriction
  });
});
