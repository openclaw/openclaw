import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import { quoteCliArg } from "../quote-cli-arg.js";
import { runtimeFixture } from "./update-command-fixtures.test-support.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";

const { fixture } = installFreshUpdateFixture();
const engine = ">=24.22.1 <25 || >=26.12.1";

it.skipIf(process.platform === "win32").each([true, false])(
  "never executes a relative PATH Node, including diagnostics (restart=%s)",
  async (restart) => {
    const current = stubNodeRuntime();
    vi.spyOn(process, "versions", "get").mockReturnValue({ ...current.versions, node: "26.8.2" });
    const workspace = path.join(path.dirname(fixture.root), "workspace");
    const marker = path.join(workspace, "executed");
    const serviceNode = path.join(path.dirname(fixture.root), "service-node", "node");
    fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(serviceNode), { recursive: true });
    fs.writeFileSync(serviceNode, "fixture", { mode: 0o755 });
    fs.writeFileSync(
      path.join(workspace, "bin/node"),
      `#!/bin/sh\n: > ${quoteCliArg(marker)}\nexit 1\n`,
      { mode: 0o755 },
    );
    const probe = runtimePaths.resolveNodeRuntimeInfo;
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation((executable, ...args) =>
      executable === serviceNode || executable === current.execPath
        ? Promise.resolve(runtimeFixture("26.8.2", "3.53.0"))
        : probe(executable, ...args),
    );
    const result = await resolvePackageRuntimePreflight({
      engineOnly: true,
      target: { version: "2026.10.9", nodeEngine: engine },
      nodeRunner: serviceNode,
      shouldRestart: restart,
      runtimeRecovery: {
        env: {
          HOME: path.dirname(fixture.root),
          PATH: `${path.relative(process.cwd(), path.join(workspace, "bin"))}${path.delimiter}${path.dirname(current.execPath)}`,
        },
      },
      service: {
        running: true,
        serviceUpdateVerdict: {
          kind: "owned",
          root: fixture.root,
          fingerprint: "fixture",
          refreshDefinition: true,
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  },
);
