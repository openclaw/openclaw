import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { resolvePackageActivationHelper } from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  readPackageActivationReceipt,
  runPackageActivationRecovery,
} from "../../infra/package-update-activation.js";
import * as packageTarget from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as shared from "./shared.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import { updateCommand } from "./update-command.js";
import { createInterruptedPackagePublication } from "./update-package-publication.test-support.js";

const mocks = vi.hoisted(() => ({ root: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
let fixtureRoot: string;
beforeEach(async () => {
  fixtureRoot = fixtures.setup().root;
  state = await createOpenClawTestState({
    label: "package-admission",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await state.cleanup();
  await fixtures.lifetime.cleanup();
  vi.restoreAllMocks();
});

function snapshot(root: string) {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .toSorted()
    .map((name) => {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      return { name, inode: stat.ino, bytes: stat.isFile() ? fs.readFileSync(file) : undefined };
    });
}
async function expectUnchanged(work: () => Promise<unknown>) {
  const before = snapshot(fixtureRoot);
  await work();
  expect(snapshot(fixtureRoot)).toEqual(before);
}

function preparePreview(
  f: Pick<Awaited<ReturnType<typeof fixtures.prepare>>, "params" | "packageRoot">,
) {
  mocks.root.mockResolvedValue(f.packageRoot);
  vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(f.params.installTarget);
  vi.spyOn(packageTarget, "fetchNpmPackageTargetStatus").mockResolvedValue({
    version: "3.0.0",
    nodeEngine: ">=24.16.0",
  });
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(createMockGatewayService());
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
}
const preview = () => updateCommand({ dryRun: true, json: true, tag: "3.0.0" });
function expectPreview(note: RegExp, targetVersion?: string) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      dryRun: true,
      ...(targetVersion ? { targetVersion } : {}),
      notes: expect.arrayContaining([expect.stringMatching(note)]),
    }),
  );
}
function writeRunnablePackage(root: string, entry = 'import "./dist/index.js";\n') {
  fs.writeFileSync(path.join(root, "openclaw.mjs"), entry);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "1.0.0",
      type: "module",
      bin: { openclaw: "openclaw.mjs" },
    }),
  );
}
async function publication(phase: Parameters<typeof createInterruptedPackagePublication>[1]) {
  const f = await createInterruptedPackagePublication(fixtureRoot, phase);
  preparePreview(f);
  return {
    ...f,
    liveFile: path.join(f.packageRoot, "dist/index.js"),
    previousFile: path.join(f.anchor, "previous/dist/index.js"),
    retiredFile: path.join(
      `${f.anchor}.superseded-${f.record.descriptor.operationId}`,
      "previous/dist/index.js",
    ),
  };
}

describe.skipIf(process.platform === "win32")("package activation admission", () => {
  it.each(["prepared", "publishing", "publication-complete", "damaged candidate"] as const)(
    "admits only a verified completed publication with the original lease (%s)",
    async (phase) => {
      const f = await publication(phase === "damaged candidate" ? "publication-complete" : phase);
      if (phase === "damaged candidate") {
        fs.appendFileSync(f.liveFile, "// changed live content\n");
      }
      const retained = () => [snapshot(f.packageRoot), snapshot(f.anchor)];
      const before = retained();
      if (phase !== "publication-complete") {
        await expect(prepareUpdateCommand({ json: true })).rejects.toThrow(
          phase === "damaged candidate"
            ? "inventoried dist files changed"
            : "openclaw update repair",
        );
        expect(retained()).toEqual(before);
        return;
      }
      const previous = fs.readFileSync(f.previousFile);
      const candidate = fs.readFileSync(f.liveFile);
      await expectUnchanged(preview);
      expectPreview(/Would settle.*update can proceed/);

      await expect(prepareUpdateCommand({ json: true })).resolves.toMatchObject({
        discoveredRoot: f.packageRoot,
      });

      assertManagedUpdateLeaseDatabaseIdentity(f.record.descriptor.authority);
      expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
      expect(fs.readFileSync(f.liveFile)).toEqual(candidate);
      expect(fs.readFileSync(f.retiredFile)).toEqual(previous);
    },
  );
  it.each(
    (["missing", "replaced"] as const).flatMap((lease) =>
      (["candidate", "previous", "damaged candidate"] as const).map((live) => ({ lease, live })),
    ),
  )(
    "dry-run preserves a publication-complete receipt with a $lease lease and $live live",
    async ({ lease, live }) => {
      const f = await publication("publication-complete");
      const previousBytes = fs.readFileSync(f.previousFile);
      if (live === "previous") {
        const previousRoot = path.join(f.anchor, "previous");
        writeRunnablePackage(previousRoot);
        fs.renameSync(f.packageRoot, path.join(f.anchor, "candidate"));
        fs.renameSync(path.join(f.anchor, "previous"), f.packageRoot);
      } else if (live === "damaged candidate") {
        fs.appendFileSync(f.liveFile, "// changed live content\n");
      }
      const { databasePath } = f.record.descriptor.authority;
      fs.renameSync(databasePath, `${databasePath}.lost`);
      if (lease === "replaced") {
        fs.copyFileSync(`${databasePath}.lost`, databasePath);
        fs.chmodSync(databasePath, 0o600);
      }
      const packageBytes = fs.readFileSync(f.liveFile);
      if (live === "damaged candidate") {
        await expectUnchanged(() => expect(preview()).rejects.toMatchObject({ code: 1 }));
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "update-recovery-pending" }),
        );
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("inventoried dist files changed"),
        );
        return;
      }
      await expectUnchanged(preview);
      expectPreview(/Would settle.*update can proceed/, "3.0.0");
      const previousPostCore = process.env[POST_CORE_UPDATE_ENV];
      vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
      try {
        await expectUnchanged(() =>
          expect(prepareUpdateCommand({ dryRun: true, json: true })).rejects.toMatchObject({
            name: "UpdateCommandPendingRecoveryFailure",
          }),
        );
      } finally {
        vi.stubEnv(POST_CORE_UPDATE_ENV, previousPostCore);
      }
      await prepareUpdateCommand({ json: true });
      expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
      expect(fs.readFileSync(f.liveFile)).toEqual(packageBytes);
      if (live === "candidate") {
        expect(fs.readFileSync(f.retiredFile)).toEqual(previousBytes);
      }
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Settled previous package update"),
      );
    },
  );
  it("previews archival of a completed receipt without changing a leftover helper", async () => {
    const f = await fixtures.prepare();
    await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
    await runPackageActivationRecovery(f.anchor, "retire", f.operationId);
    fs.writeFileSync(resolvePackageActivationHelper(f.anchor), "retained helper");
    writeRunnablePackage(f.packageRoot, "export {};\n");
    fs.unlinkSync(f.launcher);
    fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", f.launcher);
    preparePreview(f);
    await expectUnchanged(preview);
    expectPreview(/publication-retired/);
  });
});
