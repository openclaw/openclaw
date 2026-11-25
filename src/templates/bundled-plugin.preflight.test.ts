import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import * as securityEvents from "../plugins/security-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { snapshotTemplateDependencyDirectory } from "./dependency-directory.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { preflightTemplatePackage } from "./package-preflight.js";
import { installTemplatePackages } from "./packages.js";
import { validateTemplateProject } from "./project.js";

const io = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: npm and the operator's policy executable are external I/O;
// native staging, dependency traversal, policy admission and warning replay stay real.
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: (...args: Parameters<typeof actual.runCommandWithTimeout>) => {
      const [command] = args;
      return command[0] === "npm" ||
        command.some((arg) => arg.endsWith("npm-cli.js") || arg.endsWith("policy.cjs"))
        ? io.run(...args)
        : actual.runCommandWithTimeout(...args);
    },
  };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  io.run.mockReset();
});

it.each([false, true])(
  "reviews source/dependency policy warnings before bundled plugin commit (source warning: %s)",
  async (sourceWarning) => {
    const root = dirs.make("template-plugin-preflight-");
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    };
    const plugin = path.join(root, "plugins", "checked");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(env.OPENCLAW_STATE_DIR);
    writeJsonFile(path.join(plugin, "package.json"), {
      name: "checked",
      version: "1.0.0",
      type: "module",
      dependencies: { "fixture-dependency": "1.0.0" },
      openclaw: { extensions: ["./index.js"] },
    });
    writeJsonFile(path.join(plugin, "openclaw.plugin.json"), {
      id: "checked",
      configSchema: { type: "object", properties: {} },
    });
    await fs.writeFile(
      path.join(plugin, "index.js"),
      "export default { id: 'checked', register() {} };\n",
    );
    const policy = path.join(root, "policy.cjs");
    await fs.writeFile(policy, "// Synthetic operator policy executable.\n", { mode: 0o700 });
    const config: OpenClawConfig = {
      security: {
        installPolicy: {
          enabled: true,
          exec: { source: "exec", command: process.execPath, args: [policy] },
        },
      },
    };
    const configText = JSON.stringify(config);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, configText);
    writeJsonFile(path.join(root, "package.json"), {
      name: "reviewed-template",
      version: "1.0.0",
      openclaw: { template: "CLAW.md" },
    });
    await fs.writeFile(
      path.join(root, "CLAW.md"),
      `---\n${JSON.stringify({ schemaVersion: 1, agent: { id: "reviewed" }, plugins: [{ path: "plugins/checked" }] })}\n---\nReview checked evidence.\n`,
    );
    const phases: string[] = [];
    let dependencyScans = 0;
    let changeAt = Number.POSITIVE_INFINITY;
    let installedDependencies = 0;
    io.run.mockImplementation(
      async (_command: string[], options: { cwd: string; input?: string }) => {
        if (options.input) {
          const request = JSON.parse(options.input);
          phases.push(request.plugin.contentType);
          const dependency = request.plugin.contentType === "dependency-tree";
          if (dependency) {
            dependencyScans++;
            expect(
              await fs.readFile(
                path.join(request.sourcePath, "node_modules", "fixture-dependency", "index.js"),
                "utf8",
              ),
            ).toBe("dependency bytes\n");
          }
          return {
            code: 0,
            stdout: JSON.stringify(
              dependency || sourceWarning
                ? {
                    protocolVersion: 1,
                    decision: "warn",
                    reason: dependency
                      ? dependencyScans >= changeAt
                        ? "Dependency warning changed"
                        : "Review resolved dependencies"
                      : "Review bundled source",
                    findings: [
                      {
                        ruleId: dependency ? "dependency-rule" : "source-rule",
                        severity: "warn",
                        message: dependency ? "Dependency evidence" : "Source evidence",
                        file: "index.js",
                        line: 1,
                      },
                    ],
                  }
                : { protocolVersion: 1, decision: "allow" },
            ),
            stderr: "",
            killed: false,
          };
        }
        installedDependencies++;
        const directory = path.join(options.cwd, "node_modules", "fixture-dependency");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
        );
        await fs.writeFile(path.join(directory, "index.js"), "dependency bytes\n");
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    );
    const success = vi.spyOn(securityEvents, "emitPluginInstallSecurityEvent");
    const snapshot = await snapshotTemplateDependencyDirectory({
      rootDir: root,
      path: "plugins/checked",
    });
    await withEnvAsync(env, async () => {
      const result = await preflightTemplatePackage(
        { source: "bundled", kind: "plugin", path: "plugins/checked" },
        path.join(root, "workspace"),
        { packageRoot: root, snapshot, config, env },
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        warning: expect.stringContaining("Review resolved dependencies"),
        installPolicyWarningDigest: expect.stringMatching(/^sha256:/u),
      });
      expect(phases).toEqual(
        sourceWarning
          ? ["package", "package", "dependency-tree", "dependency-tree"]
          : ["package", "dependency-tree", "dependency-tree"],
      );
      if (result.ok) {
        expect(result.warning).toContain(
          "[WARN] dependency-rule: Dependency evidence (index.js:1)",
        );
        if (sourceWarning) {
          expect(result.warning).toContain("[WARN] source-rule: Source evidence (index.js:1)");
        }
      }
      expect(installedDependencies).toBe(1);
      expect(success).not.toHaveBeenCalled();
      expect(await fs.readdir(env.OPENCLAW_STATE_DIR)).not.toContain("extensions");
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(configText);
      const validated = await validateTemplateProject(root);
      if (!validated.ok) {
        throw new Error(JSON.stringify(validated.diagnostics));
      }
      const plan = await buildTemplateAddPlan({
        ...validated.template,
        bundledSources: validated.template.snapshot.bundledSources,
        context: {
          config,
          workspace: path.join(root, "workspace"),
          packagePreflight: (dependency, workspace, source) =>
            preflightTemplatePackage(dependency, workspace, { ...source, config, env }),
        },
      });
      expect(plan.blockers).toEqual([]);
      dependencyScans = 0;
      // Apply rechecks the reviewed preparation first; the actual install then
      // receives a different operator warning before its publication boundary.
      changeAt = 3;
      const apply = () =>
        installTemplatePackages(plan, {
          config,
          env,
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          pluginConsent: {
            confirmInstall: async () => true,
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          },
        });
      const changedWarning = await apply().catch((error: unknown) => error);
      expect(changedWarning, inspect(changedWarning, { depth: 8 })).toMatchObject({
        code: "package_owner_state_changed",
      });
      expect(success).not.toHaveBeenCalled();
      expect(
        await fs.readdir(path.join(env.OPENCLAW_STATE_DIR, "extensions")).catch(() => []),
      ).toEqual([]);
      expect(await loadInstalledPluginIndexInstallRecords({ env })).toEqual({});
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(configText);
      dependencyScans = 0;
      changeAt = Number.POSITIVE_INFINITY;
      expect(await apply()).toEqual([
        expect.objectContaining({ status: "complete", installId: "checked" }),
      ]);
      const installed = (await loadInstalledPluginIndexInstallRecords({ env })).checked;
      expect(installed).toMatchObject({
        source: "archive",
        sourcePath: plugin,
        integrity: expect.stringMatching(/^sha256:/u),
      });
      expect(
        await fs.readFile(
          path.join(installed!.installPath!, "node_modules", "fixture-dependency", "index.js"),
          "utf8",
        ),
      ).toBe("dependency bytes\n");
      expect(success).toHaveBeenCalledOnce();
    });
  },
);
