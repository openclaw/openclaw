import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent as createHookEvent,
} from "../../internal-hooks.js";
import handler from "./handler.js";

async function bootstrap({
  extraName,
  rootName = "AGENTS.md",
  sessionKey = "agent:main:main",
  packageName = "core",
}: {
  extraName: string;
  rootName?: AgentBootstrapHookContext["bootstrapFiles"][number]["name"];
  sessionKey?: string;
  packageName?: string;
}) {
  const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-");
  const extraDir = path.join(tempDir, "packages", packageName);
  await fs.mkdir(extraDir, { recursive: true });
  await fs.writeFile(path.join(extraDir, extraName), "extra context", "utf-8");
  const content = "root context";
  const context: AgentBootstrapHookContext = {
    workspaceDir: tempDir,
    bootstrapFiles: [
      {
        name: rootName,
        path: await writeWorkspaceFile({ dir: tempDir, name: rootName, content }),
        content,
        missing: false,
      },
    ],
    cfg: {
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: [`packages/*/${extraName}`] },
          },
        },
      },
    },
    sessionKey,
  };
  await handler(createHookEvent("agent", "bootstrap", sessionKey, context));
  return { context, tempDir };
}

describe("bootstrap-extra-files hook", () => {
  it("appends extra bootstrap files from configured patterns", async () => {
    const { context, tempDir } = await bootstrap({ extraName: "AGENTS.md" });
    const injected = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(injected).toHaveLength(2);
    expect(injected.map((f) => path.relative(tempDir, f.path))).toContain(
      path.join("packages", "core", "AGENTS.md"),
    );
  });

  it("appends configured nested memory without applying session policy", async () => {
    const { context, tempDir } = await bootstrap({
      extraName: "MEMORY.md",
      rootName: "MEMORY.md",
      sessionKey: "agent:main:slack:channel:c1",
    });
    const relativePaths = context.bootstrapFiles.map((file) => path.relative(tempDir, file.path));
    expect(relativePaths).toContain("MEMORY.md");
    expect(relativePaths).toContain(path.join("packages", "core", "MEMORY.md"));
  });

  it("leaves subagent allowlist enforcement to the final resolver", async () => {
    const { context } = await bootstrap({
      extraName: "SOUL.md",
      packageName: "persona",
      sessionKey: "agent:main:subagent:abc",
    });
    expect(context.bootstrapFiles.map((f) => f.name).toSorted()).toEqual(["AGENTS.md", "SOUL.md"]);
  });
});
