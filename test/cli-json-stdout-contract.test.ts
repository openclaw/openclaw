import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { expectOnlyDiagnosticLogs, withCliHome } from "./cli-json-stdout-contract.test-support.js";

it("accepts absent state and only the documented diagnostic log layouts", async () => {
  await withCliHome(async (home) => {
    const stateDir = path.join(home, "isolated-state");
    await expectOnlyDiagnosticLogs(stateDir);
    for (const relative of [
      "logs/openclaw-2026-11-20.log",
      "tmp/openclaw/openclaw-dev-2026-11-20.log",
      "tmp/openclaw-1000/openclaw-2026-11-20.1.log",
    ]) {
      const file = path.join(stateDir, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "diagnostic");
    }
    await expectOnlyDiagnosticLogs(stateDir);
  });
});

it.each([
  "state/openclaw.sqlite",
  "agents/main/agent/openclaw-agent.sqlite",
  "openclaw.json",
  "logs/not-a-log.json",
  "tmp/unexpected/file",
])("rejects operator state or unrelated artifact %s", async (relative) => {
  await withCliHome(async (home) => {
    const stateDir = path.join(home, "isolated-state");
    const file = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "unexpected");
    await expect(expectOnlyDiagnosticLogs(stateDir)).rejects.toThrow(
      "Unexpected CLI state artifact",
    );
  });
});

it.each(["", "logs"])("rejects a directory symlink at state-relative path %j", async (relative) => {
  await withCliHome(async (home) => {
    const stateDir = path.join(home, "isolated-state");
    const target = path.join(home, "outside");
    await fs.mkdir(target);
    if (relative) {
      await fs.mkdir(stateDir);
    }
    await fs.symlink(target, path.join(stateDir, relative), "junction");
    await expect(expectOnlyDiagnosticLogs(stateDir)).rejects.toThrow();
  });
});
