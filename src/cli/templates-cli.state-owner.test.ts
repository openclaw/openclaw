import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { templatesAddHandlers } from "../gateway/server-methods/templates-add.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { defaultRuntime } from "../runtime.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runTemplatesAddCommand } from "./templates-cli.runtime.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of (await listDirectoryTreeStrict(root)).map((walkEntry) => walkEntry.dirent)) {
    const filename = path.join(entry.parentPath, entry.name);
    snapshot[path.relative(root, filename)] = entry.isDirectory()
      ? "directory"
      : (await fs.readFile(filename)).toString("base64");
  }
  return snapshot;
}

describe("Template Add CLI state ownership", () => {
  const fixture = useLocalStateOwnerFixture();
  const output: unknown[] = [];
  afterEach(() => vi.restoreAllMocks());
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = path.dirname(process.env.OPENCLAW_STATE_DIR!);
    source = path.join(root, "CLAW.md");
    output.length = 0;
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => output.push(value));
    await fs.writeFile(
      source,
      `---\n${JSON.stringify({ schemaVersion: 1, agent: { id: "demo" } })}\n---\n`,
    );
  });

  it("rejects an unsupported online workspace override before dispatch", async () => {
    await fixture.startOwner();
    await expect(
      runTemplatesAddCommand(source, { json: true, workspace: path.join(root, "custom") }),
    ).rejects.toThrow("does not support --workspace");
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty agent ID through the live owner without creating an agent", async () => {
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ gateway: { controlUi: { experimental: { templates: true } } } }),
    );
    await fixture.startOwner();
    Object.assign(fixture.config.gateway, { controlUi: { experimental: { templates: true } } });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@proof/demo", version: "1.0.0", openclaw: { template: "CLAW.md" } }),
    );
    Object.assign(fixture.handlers, templatesAddHandlers);
    const before = await snapshotTree(root);
    await expect(runTemplatesAddCommand(source, { json: true, agentId: "" })).rejects.toThrow(
      /agentId/,
    );
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("routes local Add through the live owner while preview stays read-only", async () => {
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ gateway: { controlUi: { experimental: { templates: true } } } }),
    );
    await fixture.startOwner();
    const before = await snapshotTree(root);
    fixture.handlers["templates.add.plan"] = async ({ params, respond }) => {
      expect(params).toEqual({ source: { kind: "local", path: source } });
      respond(true, {
        planIntegrity: "sha256:reviewed",
        blockers: [],
        pluginReviews: [],
        skillReviews: [],
      });
    };
    fixture.handlers["templates.add.apply"] = async ({ params, respond }) => {
      expect(params).toMatchObject({
        source: { kind: "local", path: source },
        planIntegrity: "sha256:reviewed",
      });
      respond(true, {
        agentId: "demo",
        status: "complete",
        readiness: { ready: true, requirements: [] },
      });
    };
    await runTemplatesAddCommand(source, { json: true });
    expect(output).toEqual([expect.objectContaining({ agentId: "demo", status: "complete" })]);
    output.length = 0;
    fixture.transport.request.mockClear();
    expect(await snapshotTree(root)).toEqual(before);

    await runTemplatesAddCommand(source, { dryRun: true, json: true });
    expect(output).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ finalId: "demo" }),
        blockers: [],
      }),
    ]);
    expect(await snapshotTree(root)).toEqual(before);
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });
});
