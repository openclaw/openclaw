import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { useTriageLeaseDatabaseFixture } from "./triage-lease-fixture.test-support.js";
import { resolveManagedServiceCliArgv } from "./update-managed-service-handoff-command.js";
import { createTriageBoundary } from "./update-managed-service-triage.test-support.js";

useTriageLeaseDatabaseFixture();
const boundaries: Awaited<ReturnType<typeof createTriageBoundary>>[] = [];
afterEach(async () => {
  for (const boundary of boundaries.splice(0)) {
    await boundary.cleanup();
  }
});

describe("managed triage runtime admission (synthetic native boundary)", () => {
  it.skipIf(process.platform === "win32").for([
    { runtime: "node", updateResult: false },
    { runtime: "bun", updateResult: false },
    { runtime: "bun", updateResult: true },
  ])(
    "admits unsafe update triage on $runtime (updateResult=$updateResult) with preserved activation and deferred health",
    async ({ runtime, updateResult }, { signal }) => {
      const boundary = await createTriageBoundary("update", undefined, undefined, async (root) => {
        const node = resolveTestNodeExecPath();
        const executable = runtime === "bun" ? path.join(root, "bin", "bun") : node;
        if (runtime === "bun") {
          // Keep this IPC/native-placement fixture on Node while exercising Bun's argv contract.
          const quotedNode = "'" + node.replaceAll("'", "'\\''") + "'";
          await fs.writeFile(
            executable,
            `#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  [ "$arg" = "--no-install" ] || args+=("$arg")\ndone\nexec ${quotedNode} "\${args[@]}"\n`,
            { mode: 0o700 },
          );
        }
        const candidate = path.join(root, "candidate.mjs");
        const command = resolveManagedServiceCliArgv({ execPath: executable, argv1: candidate }, [
          "triage",
          ...(updateResult ? ["--update-result", path.join(root, "update-result.json")] : []),
        ]);
        const updater = path.join(root, "updater.cjs");
        await fs.writeFile(
          updater,
          (await fs.readFile(updater, "utf8")).replace(
            `[process.execPath,${JSON.stringify(candidate)},'triage']`,
            JSON.stringify(command),
          ),
        );
      });
      boundaries.push(boundary);
      expect(await boundary.response(), boundary.stderr()).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      await boundary.waitForBranch(signal);
      const events = await boundary.readEvents();
      const kinds = events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === "branch")).toHaveLength(1);
      expect(
        (await boundary.members()).filter((member) => member.alive).length,
      ).toBeGreaterThanOrEqual(4);
      expect(events.find((event) => event.kind === "fixer")?.failure?.gateway).toBe("preserve");
      expect(await boundary.log()).toContain('{"status":"error","reason":"original failure"}');
      expect(await boundary.log()).toContain("exited code=7 signal=null");
      expect(kinds.filter((kind) => kind === "updater")).toHaveLength(1);
      expect(kinds.filter((kind) => kind === "triage-queued")).toHaveLength(1);
      expect(
        kinds.filter((kind) => kind === "start" || kind === "restart" || kind === "restore-failed"),
      ).toEqual([]);
      expect(kinds.indexOf("attached")).toBeLessThan(kinds.indexOf("fixer"));
      await boundary.native("stop");
      await boundary.waitForEvent("scope-stopped", signal, true);
      const settledKinds = (await boundary.readEvents()).map((event) => event.kind);
      expect(settledKinds.filter((kind) => kind === "fixer")).toHaveLength(1);
      expect(settledKinds.slice(settledKinds.indexOf("attached"))).not.toContain("start");
      await boundary.cleanup();
      boundaries.splice(boundaries.indexOf(boundary), 1);
    },
  );
});
