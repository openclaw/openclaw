// Native relay hooks are cold processes, so their direct path must not load server runtimes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("native hook relay CLI import boundary", () => {
  it("loads only the client relay owner before Gateway fallback", () => {
    const cli = readSource("src/cli/native-hook-relay-cli.ts");

    expect(cli).toContain('from "../agents/harness/native-hook-relay-client.js"');
    expect(cli).not.toContain('from "../agents/harness/native-hook-relay.js"');
    expect(cli).not.toMatch(/import\s+\{\s*callGateway\s*\}\s+from\s+"..\/gateway\/call\.js"/u);
    expect(cli).toContain('import("../gateway/call.js")');
  });

  it("dispatches the hidden relay before loading the general CLI", () => {
    const entry = readSource("src/entry.ts");
    const relayDispatch = entry.indexOf('import("./cli/native-hook-relay-cli.js")');
    const generalCli = entry.indexOf('import("./cli/run-main.js")');

    expect(relayDispatch).toBeGreaterThan(-1);
    expect(generalCli).toBeGreaterThan(relayDispatch);
  });

  it.each([
    "src/agents/harness/native-hook-relay-client.ts",
    "src/agents/harness/native-hook-relay-client.worker.ts",
  ])("keeps server and writable state owners out of %s", (entry) => {
    expect(
      findSourceImportBackedges(entry, [
        "src/agents/harness/native-hook-relay-bridge.ts",
        "src/agents/harness/native-hook-relay-events.ts",
        "src/agents/harness/native-hook-relay-permissions.ts",
        "src/agents/harness/native-hook-relay-state.ts",
        "src/agents/harness/native-hook-relay-store.ts",
        "src/state/openclaw-state-db.ts",
        "src/state/openclaw-state-db-maintenance.ts",
        "src/infra/state-database-maintenance.ts",
        "src/gateway/call.ts",
      ]),
    ).toEqual([]);
  });
});
