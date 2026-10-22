import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { closeHttpServer } from "../../test/helpers/gateway-integration-fixtures.js";
import { preparePostCorePluginConfig } from "../cli/update-cli/update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "../cli/update-cli/update-command-plugins.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import * as processExecution from "../process/exec.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { installPluginFromNpmSpec } from "./install.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";

const servers: http.Server[] = [];
const dependency = "fixture-required-runtime";
const readPackage = async (root: string) =>
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const readFiles = (files: string[]) => Promise.all(files.map((file) => fs.readFile(file, "utf8")));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await closeHttpServer(server);
  }
});

// Layout/manifest variants live in status-dependencies-core and install.npm-dependencies.
// Keep real post-core publication, malformed-package reporting, and rollback here.
const payloads = ["missing", "malformed-manifest", "hoisted", "optional"] as const;
it.each([
  ...payloads.map((payload): [typeof payload, number | null | undefined] => [payload, undefined]),
  ["missing", 90_000],
  ["missing", null],
  ["hoisted", 90_000],
  ["optional", null],
] satisfies Array<[(typeof payloads)[number], number | null | undefined]>)(
  "publishes %s npm payloads transactionally (budget: %s)",
  { timeout: 180_000 },
  async (payload, workTimeoutMs) => {
    const expectedTimeoutMs = workTimeoutMs === null ? undefined : (workTimeoutMs ?? 120_000);
    // Ambient provider credentials must not add installs to this synthetic registry.
    const credentialKeys = listKnownProviderAuthEnvVarNamesCore({ config: {}, env: process.env });
    await withOpenClawTestState(
      {
        label: `post-core-dependency-${payload}`,
        env: {
          ...Object.fromEntries(credentialKeys.map((key) => [key, undefined])),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        const control = state.path("control");
        await fs.mkdir(control, { mode: 0o700 });
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const packageName = `dependency-owner-${crypto.randomUUID()}`;
        const indexJs = `export default { id: ${JSON.stringify(packageName)}, register() {} };\n`;
        const versions = await packPlugins(state.path("packages"), [
          { packageName, version: "1.0.0", indexJs },
          {
            packageName,
            version: "2.0.0",
            indexJs,
            dependencies: { [dependency]: "1.0.0" },
            optionalDependencies: payload === "optional" ? { [dependency]: "1.0.0" } : undefined,
          },
          { packageName: dependency },
        ]);
        const registry = await startStaticRegistry(
          [
            { packageName, latest: "2.0.0", versions: versions.slice(0, 2) },
            { packageName: dependency, latest: "1.0.0", versions: versions.slice(2) },
          ],
          servers,
        );
        vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
        vi.stubEnv("npm_config_registry", registry);
        vi.stubEnv("NPM_CONFIG_CACHE", state.path("npm-cache"));
        const npmDir = state.statePath("npm");
        const roots = {
          npmDir,
          extensionsDir: state.statePath("extensions"),
          gitDir: state.statePath("git"),
          stateDir: state.stateDir,
        };
        await withPluginInstallRoots(roots, async () => {
          const installed = await installPluginFromNpmSpec({
            npmDir,
            spec: `${packageName}@1.0.0`,
            timeoutMs: 120_000,
            logger: { info: () => {}, warn: () => {} },
          });
          if (!installed.ok) {
            throw new Error(installed.error);
          }
          const projectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
          const protectedFiles = [
            ...["package.json", "package-lock.json"].map((file) => path.join(projectRoot, file)),
            ...["package.json", "openclaw.plugin.json", "dist/index.js"].map((file) =>
              path.join(installed.targetDir, file),
            ),
          ];
          const config = {
            plugins: { allow: [packageName], entries: { [packageName]: { enabled: true } } },
          };
          const records: Record<string, PluginInstallRecord> = {
            [packageName]: {
              source: "npm",
              spec: packageName,
              installPath: installed.targetDir,
              version: "1.0.0",
            },
          };
          await state.writeConfig(config);
          await seedInstalledPluginIndex(records, { config, env: process.env });
          protectedFiles.push(state.configPath);
          const before = await readFiles(protectedFiles);
          let successfulNpmInstalls = 0;
          const realRun = processExecution.runCommandWithTimeout;
          vi.spyOn(processExecution, "runCommandWithTimeout").mockImplementation(
            async (...args) => {
              const result = await realRun(...args);
              const [argv, options] = args;
              if (
                npmCommandArgs(argv)?.[0] !== "install" ||
                argv.includes("--package-lock-only") ||
                result.code !== 0
              ) {
                return result;
              }
              expect(typeof options === "object" ? options.timeoutMs : options).toBe(
                expectedTimeoutMs,
              );
              const attemptRoot = expectDefined(
                typeof options === "object" ? options.cwd : undefined,
                "real npm staging directory",
              );
              const pluginRoot = path.join(attemptRoot, "node_modules", packageName);
              expect(await readPackage(pluginRoot)).toMatchObject({ version: "2.0.0" });
              successfulNpmInstalls += 1;
              const hoisted = path.join(attemptRoot, "node_modules", dependency);
              expect(await readPackage(hoisted)).toMatchObject({ name: dependency });
              if (payload === "malformed-manifest") {
                await fs.writeFile(path.join(hoisted, "package.json"), "{");
              } else if (payload !== "hoisted") {
                await fs.rm(hoisted, { recursive: true });
              }
              return result;
            },
          );
          const onCapabilityConsent = vi.fn(async (review: { reviewToken: string }) => ({
            reviewToken: review.reviewToken,
          }));
          const result = await withPluginCache(createPluginCache(), async () =>
            updatePluginsAfterCoreUpdate({
              root: state.root,
              channel: "stable",
              ...(await preparePostCorePluginConfig({ requestedChannel: null })),
              pluginInstallRecords: records,
              timeoutMs: 120_000,
              workTimeoutMs,
              json: true,
              onCapabilityConsent,
            }),
          );
          expect(successfulNpmInstalls, JSON.stringify(result)).toBe(1);
          const persisted = expectDefined(
            await readPersistedInstalledPluginIndexInstallRecordsAsync(),
            "persisted installed-plugin index",
          );
          const succeeds = payload === "hoisted" || payload === "optional";
          const outcome = succeeds
            ? { status: "updated", nextVersion: "2.0.0" }
            : {
                status: "error",
                message: expect.stringContaining(
                  payload.endsWith("manifest") ? "package.json" : dependency,
                ),
              };
          expect(result.status).toBe(succeeds ? "ok" : "warning");
          expect(result.npm.outcomes).toContainEqual(
            expect.objectContaining({ pluginId: packageName, ...outcome }),
          );
          if (succeeds) {
            expect(persisted[packageName]?.version).toBe("2.0.0");
            expect(await readPackage(persisted[packageName]!.installPath!)).toMatchObject({
              version: "2.0.0",
            });
          } else {
            expect(onCapabilityConsent).not.toHaveBeenCalled();
            expect(persisted).toEqual(records);
            expect(await readFiles(protectedFiles)).toEqual(before);
          }
        });
      },
    );
  },
);
