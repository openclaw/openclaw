import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { resolvePackageActivationJournalPath } from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import * as packageTarget from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as shared from "./shared.js";
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

describe.skipIf(process.platform === "win32")("package activation admission", () => {
  it.each(
    (["missing", "replaced"] as const).flatMap((lease) =>
      (["candidate", "previous", "damaged candidate"] as const).map((live) => ({ lease, live })),
    ),
  )(
    "dry-run reconciles a publication-complete receipt with a $lease lease and $live live",
    async ({ lease, live }) => {
      const f = await createInterruptedPackagePublication(fixtureRoot, "publication-complete");
      mocks.root.mockResolvedValue(f.packageRoot);
      const retainedPrevious = path.join(f.anchor, "previous/dist/index.js");
      const previousBytes = fs.readFileSync(retainedPrevious);
      if (live === "previous") {
        const previousRoot = path.join(f.anchor, "previous");
        fs.writeFileSync(path.join(previousRoot, "openclaw.mjs"), 'import "./dist/index.js";\n');
        fs.writeFileSync(
          path.join(previousRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            version: "1.0.0",
            type: "module",
            bin: { openclaw: "openclaw.mjs" },
          }),
        );
        fs.renameSync(f.packageRoot, path.join(f.anchor, "candidate"));
        fs.renameSync(path.join(f.anchor, "previous"), f.packageRoot);
      } else if (live === "damaged candidate") {
        fs.appendFileSync(path.join(f.packageRoot, "dist/index.js"), "// changed live content\n");
      }
      const { databasePath } = f.record.descriptor.authority;
      fs.renameSync(databasePath, `${databasePath}.lost`);
      if (lease === "replaced") {
        fs.copyFileSync(`${databasePath}.lost`, databasePath);
        fs.chmodSync(databasePath, 0o600);
      }
      vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
      vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(
        f.params.installTarget,
      );
      vi.spyOn(packageTarget, "fetchNpmPackageTargetStatus").mockResolvedValue({
        version: "3.0.0",
        nodeEngine: ">=24.16.0",
      });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(createMockGatewayService());
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
      const packageBytes = fs.readFileSync(path.join(f.packageRoot, "dist/index.js"));
      const journalBytes = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));

      if (live === "damaged candidate") {
        await expect(
          updateCommand({ dryRun: true, json: true, tag: "3.0.0" }),
        ).rejects.toMatchObject({ code: 1 });
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "update-recovery-pending" }),
        );
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("inventoried dist files changed"),
        );
        expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(
          journalBytes,
        );
        expect(fs.readFileSync(retainedPrevious)).toEqual(previousBytes);
        return;
      }

      await updateCommand({ dryRun: true, json: true, tag: "3.0.0" });

      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, targetVersion: "3.0.0" }),
      );
      expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
      expect(fs.readFileSync(path.join(f.packageRoot, "dist/index.js"))).toEqual(packageBytes);
      if (live === "candidate") {
        expect(
          fs.readFileSync(
            `${f.anchor}.superseded-${f.record.descriptor.operationId}/previous/dist/index.js`,
          ),
        ).toEqual(previousBytes);
      }
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("previous package update"),
      );
    },
  );
});
