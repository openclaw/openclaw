import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";

it("keeps real onboarding warnings but omits the rehearsal's synthetic loopback finding", async () => {
  const cfg: OpenClawConfig = {
    gateway: { bind: "loopback", auth: { mode: "token", token: "synthetic-token" } },
    tools: { exec: { host: "node" } },
    plugins: { entries: { "device-pair": { enabled: false } } },
  };
  const unused = async () => {
    throw new Error("Unrelated Doctor repair must not run");
  };
  const checks = resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: unused,
    runGatewayConfigHealth: unused,
    runAuthProfileMigration: unused,
    runAuthProfileHealth: unused,
    runGatewayAuthHealth: unused,
    runLegacyStateHealth: unused,
  })
    .flatMap((contribution) => contribution.healthChecks)
    .filter((check) => check.id === "core/doctor/node-hosting-preconditions");
  const lint = async (env?: NodeJS.ProcessEnv) => {
    const result = await runDoctorLintChecks(
      { mode: "lint", cfg, env, runtime: { log() {}, error() {}, exit() {} } },
      { checks },
    );
    return result.findings
      .map((finding) => finding.requirement)
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
  };
  for (const env of [undefined, { OPENCLAW_UPDATE_IN_PROGRESS: "1" }]) {
    expect(await lint(env)).toEqual(["node-onboarding-plugin", "node-onboarding-url"]);
  }
  const rehearsal = {
    ...buildUpdateRehearsalPathEnv(path.join(process.cwd(), ".artifacts", "rehearsal")),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
  };
  expect(await lint(rehearsal)).toEqual(["node-onboarding-plugin"]);
});
