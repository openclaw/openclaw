import { describe, expect, it } from "vitest";
import {
  detectCoreInstallPathIssue,
  formatCoreInstallPathIssue,
} from "./core-install-path-check.js";

describe("detectCoreInstallPathIssue", () => {
  it("reports aligned service entrypoints as none", async () => {
    const issue = await detectCoreInstallPathIssue({
      packageRoot: "/opt/openclaw",
      expectedProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      serviceProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      configPathCli: "/home/test/.openclaw/openclaw.json",
      configPathService: "/home/test/.openclaw/openclaw.json",
    });

    expect(issue.driftKind).toBe("none");
    expect(issue.severity).toBe("info");
  });

  it("reports same-root entrypoint differences as a warning", async () => {
    const issue = await detectCoreInstallPathIssue({
      packageRoot: "/opt/openclaw",
      expectedProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      serviceProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/entry.js", "gateway"],
      configPathCli: "/home/test/.openclaw/openclaw.json",
      configPathService: "/home/test/.openclaw/openclaw.json",
    });

    expect(issue.driftKind).toBe("entrypoint-shape-mismatch");
    expect(issue.severity).toBe("warn");
  });

  it("reports different install roots as an error", async () => {
    const issue = await detectCoreInstallPathIssue({
      packageRoot: "/home/test/.npm-global/lib/node_modules/openclaw",
      expectedProgramArguments: [
        "/usr/bin/node",
        "/home/test/.npm-global/lib/node_modules/openclaw/dist/index.js",
        "gateway",
      ],
      serviceProgramArguments: [
        "/usr/bin/node",
        "/usr/lib/node_modules/openclaw/dist/index.js",
        "gateway",
      ],
      configPathCli: "/home/test/.openclaw/openclaw.json",
      configPathService: "/home/test/.openclaw/openclaw.json",
    });

    expect(issue.driftKind).toBe("service-points-elsewhere");
    expect(issue.severity).toBe("error");
  });

  it("reports config path mismatches before path shape mismatches", async () => {
    const issue = await detectCoreInstallPathIssue({
      packageRoot: "/opt/openclaw",
      expectedProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      serviceProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      configPathCli: "/home/test/.openclaw/openclaw.json",
      configPathService: "/srv/openclaw/openclaw.json",
    });

    expect(issue.driftKind).toBe("config-path-mismatch");
    expect(issue.severity).toBe("warn");
  });

  it("formats summaries compactly", async () => {
    const issue = await detectCoreInstallPathIssue({
      packageRoot: "/opt/openclaw",
      expectedProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      serviceProgramArguments: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
    });

    expect(formatCoreInstallPathIssue(issue)).toContain("ok");
    expect(formatCoreInstallPathIssue(issue)).toContain("Current install root");
  });
});
