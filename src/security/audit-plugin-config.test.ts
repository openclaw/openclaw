import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHomeCore as withTempHome } from "../plugin-sdk/test-helpers/temp-home.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runSecurityAuditCore } from "./audit.js";

it("plain audit invokes only admitted config artifacts without activating plugin runtime", async () => {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const runtimeMarker = path.join(home, "runtime-loaded");
      const forbiddenArtifactMarker = path.join(home, "forbidden-artifact-loaded");
      const ids = [
        "audit-example",
        "audit-disabled",
        "audit-undeclared",
        "audit-broken",
        "audit-external",
      ];
      let externalRoot = "";
      for (const id of ids) {
        const root = path.join(home, id === "audit-external" ? "external" : "bundled", id);
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            securityAuditConfig: id !== "audit-undeclared",
            configSchema: { type: "object", additionalProperties: true },
          }),
        );
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ type: "commonjs", openclaw: { extensions: ["./index.js"] } }),
        );
        await fs.writeFile(
          path.join(root, "index.js"),
          `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded");
throw new Error("Runtime entrypoint must not execute during plain audit");`,
        );
        if (id === "audit-broken") {
          continue;
        }
        await fs.writeFile(
          path.join(root, "security-audit-api.js"),
          id === "audit-example"
            ? `exports.collectConfigSecurityAuditFindings = (context) => [{
  checkId: "fixture.config_policy", severity: "warn", title: "Example config policy",
  detail: context.config.plugins.entries["audit-example"].config.note,
}];`
            : `require("node:fs").writeFileSync(${JSON.stringify(forbiddenArtifactMarker)}, "loaded");
exports.collectConfigSecurityAuditFindings = () => [];`,
        );
        if (id === "audit-external") {
          externalRoot = root;
        }
      }
      const config: OpenClawConfig = {
        plugins: {
          allow: ids,
          load: { paths: [externalRoot] },
          entries: {
            "audit-example": { enabled: true, config: { note: "configured example policy" } },
            "audit-disabled": { enabled: false },
            "audit-undeclared": { enabled: true },
            "audit-broken": { enabled: true },
            "audit-external": { enabled: true },
          },
        },
      };
      try {
        const report = await runSecurityAuditCore({
          config,
          sourceConfig: config,
          env: process.env,
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          workspaceDir: path.join(home, "workspace"),
          includeFilesystem: false,
          deep: false,
          loadPluginSecurityCollectors: false,
          configSnapshot: null,
        });
        expect(report.findings).toContainEqual({
          checkId: "fixture.config_policy",
          severity: "warn",
          title: "Example config policy",
          detail: "configured example policy",
        });
        expect(
          report.findings
            .filter((finding) => finding.checkId.endsWith("config_security_audit_failed"))
            .toSorted((left, right) => left.checkId.localeCompare(right.checkId)),
        ).toEqual([
          expect.objectContaining({
            checkId: "plugins.audit-broken.config_security_audit_failed",
            severity: "warn",
            detail: expect.stringContaining("security-audit-api.js"),
          }),
          expect.objectContaining({
            checkId: "plugins.audit-external.config_security_audit_failed",
            severity: "warn",
            detail: expect.stringContaining("bundled or verified official"),
          }),
        ]);
        await expect(fs.stat(runtimeMarker)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(forbiddenArtifactMarker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ HOME: home, OPENCLAW_STATE_DIR: stateDir }),
        );
      }
    },
    {
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "bundled"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      },
    },
  );
});
