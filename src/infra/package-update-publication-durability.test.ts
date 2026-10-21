import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as durability from "./directory-durability.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-journal.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import {
  preparePackageActivation,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import * as integrity from "./package-update-integrity.js";
import {
  createPublicationTestFixture,
  withPublicationFence,
  runPublicationSwap,
  readPublicationText as read,
  readPublicationManifest as manifest,
} from "./package-update-publication.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { interceptStagedFileSync } from "./package-update-sync.test-support.js";
import * as capability from "./update-post-core-capability.js";

async function prepareFixtureActivation(
  f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
  fence: Parameters<typeof preparePackageActivation>[0]["options"]["fence"],
) {
  const reader = integrity.createPackageIntegrityReader();
  return preparePackageActivation({
    options: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
    installTarget: f.params.installTarget,
    liveRoot: f.packageRoot,
    stageRoot: f.params.stage.packageRoot,
    launcherRoot: f.params.stage.layout.binDir,
    binDir: path.dirname(f.launcher),
    previous: await reader.tree(f.packageRoot),
    launchers: [
      {
        name: "openclaw",
        previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
      },
    ],
  });
}

const fixture = createPublicationTestFixture();

const withFixture = fixture.withFixture;

it
  .skipIf(process.platform === "win32")
  .each([
    "unchanged",
    "initially-fresh",
    "previous",
    "candidate",
    "candidate-version",
    "candidate-directory",
    "interrupted",
  ] as const)(
  "reuses the previous digest and trusts freshly prepared candidate contents (%s)",
  withFixture(async (f, changed: string) => {
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const previousRoot = path.join(anchor, "previous");
    const candidateRoot = path.join(anchor, "candidate");
    let now = Date.now() + (changed === "initially-fresh" ? 0 : 6_000);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await withPublicationFence(f.packageRoot, async (fence) => {
      const prepared = await prepareFixtureActivation(f, fence);
      expect(prepared).toBeDefined();
      if (changed === "interrupted") {
        const failure = new Error("package helper read interrupted");
        const interruptedRead = vi.spyOn(fsp, "readFile").mockRejectedValueOnce(failure);
        await expect(prepared!.publish(false)).rejects.toBe(failure);
        interruptedRead.mockRestore();
      }
      const tampered = path.join(
        changed === "previous" ? f.packageRoot : candidateRoot,
        "dist/index.js",
      );
      if (changed === "candidate-version") {
        await fsp.writeFile(
          path.join(candidateRoot, "package.json"),
          '{"name":"openclaw","version":"3.0.0"}',
        );
      } else if (changed === "candidate-directory") {
        await fsp.rename(candidateRoot, path.join(fixture.root, "displaced-candidate"));
        await fsp.mkdir(candidateRoot);
        await fsp.writeFile(
          path.join(candidateRoot, "package.json"),
          '{"name":"openclaw","version":"2.0.0"}',
        );
      } else if (changed === "previous" || changed === "candidate" || changed === "interrupted") {
        await fsp.writeFile(tampered, `changed ${changed} package content\n`);
      }
      now += 6_000;
      const hash = interceptPackageFileHashes();
      const packageOpens: string[] = [];
      const open = fsp.open.bind(fsp);
      vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        const file = String(args[0]);
        if (
          [f.packageRoot, previousRoot, candidateRoot].some((directory) =>
            file.startsWith(`${directory}${path.sep}`),
          ) &&
          fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()
        ) {
          packageOpens.push(file);
        }
        return open(...args);
      });
      const publishing = prepared!.publish(false);
      if (changed === "candidate-version" || changed === "candidate-directory") {
        await expect(publishing).rejects.toThrow("Package publication object changed");
        expect(hash).not.toHaveBeenCalled();
        expect(read(f.launcher)).toBe("old launcher\n");
        return;
      }
      if (changed === "previous" || changed === "interrupted") {
        await expect(publishing).rejects.toBeInstanceOf(integrity.PackageIntegrityMismatchError);
        expect(hash.mock.calls.map(([file]) => file)).toEqual([tampered]);
        expect(read(f.launcher)).toBe("old launcher\n");
        return;
      }
      await expect(publishing).resolves.toMatchObject({ phase: "publication-complete" });
      expect(read(f.launcher)).toBe("candidate launcher\n");
      if (changed === "initially-fresh") {
        // Re-read recent previous-package bytes once after they settle;
        // the private candidate does not enter the content verifier.
        expect(hash.mock.calls.length).toBeGreaterThan(0);
        expect(
          hash.mock.calls.every(([file]) => file.startsWith(`${f.packageRoot}${path.sep}`)),
        ).toBe(true);
        expect(new Set(hash.mock.calls.map(([, stat]) => `${stat.dev}:${stat.ino}`)).size).toBe(
          hash.mock.calls.length,
        );
        hash.mockClear();
      } else {
        expect(hash).not.toHaveBeenCalled();
      }
      // Version checks still read manifests without rescanning candidate payloads.
      if (changed !== "initially-fresh") {
        expect(packageOpens).toHaveLength(4);
        expect(packageOpens.every((file) => path.basename(file) === "package.json")).toBe(true);
      }
      await expect(prepared!.retire()).resolves.toMatchObject({ phase: "complete" });
      expect(hash).not.toHaveBeenCalled();
      if (changed !== "initially-fresh") {
        expect(packageOpens).toHaveLength(5);
        expect(packageOpens.every((file) => path.basename(file) === "package.json")).toBe(true);
      }
      expect(fs.existsSync(anchor)).toBe(false);
    });
  }),
);

it.skipIf(process.platform === "win32").each([
  ["displace", "anchor"],
  ["displace", "installation"],
  ["publish", "anchor"],
  ["publish", "installation"],
] as const)(
  "persists both package rename parents before advancing %s (%s failure)",
  withFixture(async (f, cut: "displace" | "publish", parent: string) => {
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const previousRoot = path.join(anchor, "previous");
    const candidateRoot = path.join(anchor, "candidate");
    const parents = [anchor, path.dirname(f.packageRoot)];
    const failedParent = parent === "anchor" ? anchor : path.dirname(f.packageRoot);
    const failure = Object.assign(new Error(`${cut} directory sync interrupted`), {
      code: "EIO",
    });
    const synced = { displace: new Set<string>(), publish: new Set<string>() };
    let faultEnabled = true;
    let refused = 0;
    let callbackDurable: boolean | undefined;
    const sync = durability.syncDirectory;
    vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      const directoryPath = typeof directory === "string" ? directory : directory.path;
      const phase = !fs.existsSync(previousRoot)
        ? undefined
        : fs.existsSync(f.packageRoot)
          ? "publish"
          : "displace";
      if (faultEnabled && phase === cut && directoryPath === failedParent) {
        refused++;
        throw failure;
      }
      const result = await sync(directory);
      if (phase) {
        synced[phase].add(directoryPath);
      }
      return result;
    });
    await withPublicationFence(f.packageRoot, async (fence) => {
      const prepared = await prepareFixtureActivation(f, fence);
      expect(prepared).toBeDefined();
      await expect(
        prepared!.publish(false, () => {
          callbackDurable = parents.every((directory) => synced.displace.has(directory));
        }),
      ).rejects.toBe(failure);
    });
    expect(refused).toBe(1);
    expect(callbackDurable).toBe(cut === "displace" ? undefined : true);
    const version = (directory: string) => manifest(directory).version;
    expect(version(previousRoot)).toBe("1.0.0");
    expect(version(cut === "displace" ? candidateRoot : f.packageRoot)).toBe("2.0.0");
    expect(fs.existsSync(cut === "displace" ? f.packageRoot : candidateRoot)).toBe(false);
    expect(read(f.launcher)).toBe("old launcher\n");
    const journal = openPackageActivationJournal(anchor);
    const pending = journal.read();
    expect(pending).toMatchObject({
      phase: "publishing",
      intent: { kind: cut },
      publications: [],
    });
    // Reopening observes the completed rename, but its missing durability
    // acknowledgement must still prevent every subsequent effect.
    await expect(
      runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
    ).rejects.toBe(failure);
    expect(refused).toBe(2);
    expect(journal.read()).toEqual(pending);
    expect(version(previousRoot)).toBe("1.0.0");
    expect(read(f.launcher)).toBe("old launcher\n");
    faultEnabled = false;
    await expect(
      runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
    ).resolves.toMatchObject({ phase: "publication-complete" });
    expect(parents.every((directory) => synced[cut].has(directory))).toBe(true);
    expect(version(f.packageRoot)).toBe("2.0.0");
    expect(read(f.launcher)).toBe("candidate launcher\n");
    await expect(
      runPackageActivationRecovery(anchor, "retire", pending.descriptor.operationId),
    ).resolves.toMatchObject({ phase: "complete" });
  }),
);

it.skipIf(process.platform === "win32").each(["anchor", "installation", "launchers"] as const)(
  "retains recovery copies when restored package %s persistence fails",
  withFixture(async (f, parent: string) => {
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const failedParent =
      parent === "anchor"
        ? anchor
        : path.dirname(parent === "launchers" ? f.launcher : f.packageRoot);
    if (parent === "launchers") {
      fs.unlinkSync(f.launcher);
    }
    const failure = Object.assign(new Error("restored directory sync interrupted"), {
      code: "EIO",
    });
    await withPublicationFence(f.packageRoot, async (fence) => {
      const { result, transaction } = await runPublicationSwap(f, fence);
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      const sync = durability.syncDirectory;
      let refused = 0;
      vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
        if (directory === failedParent && fs.existsSync(path.join(anchor, "previous.candidate"))) {
          refused++;
          throw failure;
        }
        return sync(directory);
      });
      await expect(transaction!.rollback(fence.assertCurrent)).rejects.toBe(failure);
      expect(refused).toBe(1);
      expect(openPackageActivationJournal(anchor).read().phase).toBe("rollback-in-progress");
      expect(manifest(f.packageRoot).version).toBe("1.0.0");
      expect(JSON.parse(read(anchor, "previous.candidate/package.json")).version).toBe("2.0.0");
      if (parent === "launchers") {
        expect(fs.existsSync(f.launcher)).toBe(false);
      } else {
        expect(read(f.launcher)).toBe("old launcher\n");
      }
      await expect(
        transaction!.complete({ activationVerified: true }, fence.assertCurrent),
      ).rejects.toBe(failure);
      expect(fs.existsSync(path.join(anchor, "previous.candidate"))).toBe(true);
    });
  }),
);

it.skipIf(process.platform === "win32").each([
  ["file", "EIO"],
  ["file", "EPERM"],
  ["directory", "EIO"],
] as const)(
  "does not acknowledge an unpersisted launcher %s %s and requires durability on recovery",
  withFixture(async (f, cut: string, code: string) => {
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const failure = Object.assign(new Error("launcher durability interrupted"), { code });
    const probe = interceptStagedFileSync(path.dirname(f.launcher), failure, cut === "file");
    let refused = 0;
    const sync = durability.syncDirectory;
    const syncSpy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (
        cut === "directory" &&
        directory === path.dirname(f.launcher) &&
        read(f.launcher) === "candidate launcher\n"
      ) {
        refused++;
        throw failure;
      }
      return sync(directory);
    });
    await withPublicationFence(f.packageRoot, async (fence) => {
      const prepared = await prepareFixtureActivation(f, fence);
      expect(prepared).toBeDefined();
      // Exercise the actual publication owner without the outer swap's automatic
      // compensation, leaving the interrupted operation available for recovery.
      await expect(prepared!.publish(false)).rejects.toThrow("launcher durability interrupted");
    });
    expect(refused + probe.refused).toBeGreaterThan(0);
    for (const handle of probe.handles) {
      let current: fs.BigIntStats | undefined;
      try {
        current = fs.fstatSync(handle.fd, { bigint: true });
      } catch {
        /* Closed. */
      }
      expect(current?.dev === handle.dev && current?.ino === handle.ino).toBe(false);
    }
    const journal = openPackageActivationJournal(anchor);
    const pending = journal.read();
    expect(pending).toMatchObject({ phase: "publishing", publications: [] });
    expect(fs.existsSync(path.join(anchor, "previous"))).toBe(true);
    if (cut === "directory") {
      expect(pending.intent).toMatchObject({ kind: "launcher", name: "openclaw" });
      expect(read(f.launcher)).toBe("candidate launcher\n");
      const before = refused;
      await expect(
        runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
      ).rejects.toBe(failure);
      expect(refused).toBeGreaterThan(before);
      expect(journal.read()).toEqual(pending);
    } else {
      expect(read(f.launcher)).toBe("old launcher\n");
      expect(probe.handles.length).toBeGreaterThan(0);
    }
    // The same recorded operation can finish only once the persistence boundary works.
    probe.restore();
    syncSpy.mockRestore();
    await expect(
      runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
    ).resolves.toMatchObject({ phase: "publication-complete" });
    await expect(
      runPackageActivationRecovery(anchor, "retire", pending.descriptor.operationId),
    ).resolves.toMatchObject({ phase: "complete" });
    expect(read(f.launcher)).toBe("candidate launcher\n");
    expect(fs.existsSync(anchor)).toBe(false);
  }),
);

it.skipIf(process.platform === "win32")(
  "keeps the original preparation assertion after capability and integrity awaits",
  () =>
    fixture.lifetime.run(async () => {
      const f = await createPackageSwapFixture(fixture.root);
      const previous = await integrity.createPackageIntegrityReader().tree(f.packageRoot);
      const previousLauncher = await integrity.createPackageIntegrityReader().launcher(f.launcher);
      const { promise: paused, resolve: release } = createDeferred();
      const { promise: inspecting, resolve: reached } = createDeferred();
      let preparing: ReturnType<typeof preparePackageActivation> | undefined;
      let original: (() => void) | undefined;
      const onPrepared = vi.fn();
      let outcome: { value: unknown } | { error: unknown } | undefined;
      try {
        await withPublicationFence(f.packageRoot, async (fence) => {
          original = fence.assertCurrent.bind(fence);
          vi.spyOn(capability, "supportsPostCoreExecutor").mockImplementation(async () => {
            await Promise.resolve();
            fence.assertCurrent = vi.fn();
            return true;
          });
          const create = integrity.createPackageIntegrityReader;
          vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((...args) => {
            const reader = create(...args);
            return {
              ...reader,
              tree: async (...treeArgs) => {
                const result = await reader.tree(...treeArgs);
                if (treeArgs[0] === f.params.stage.packageRoot) {
                  reached();
                  await paused;
                }
                return result;
              },
            };
          });
          preparing = preparePackageActivation({
            options: { fence, runtime: packageActivationRuntimeForTest(), onPrepared },
            installTarget: f.params.installTarget,
            liveRoot: f.packageRoot,
            stageRoot: f.params.stage.packageRoot,
            launcherRoot: f.params.stage.layout.binDir,
            binDir: path.dirname(f.launcher),
            previous,
            launchers: [
              { name: "openclaw", previous: encodePackageActivationLauncher(previousLauncher) },
            ],
          });
          void preparing.then(
            (value) => {
              outcome = { value };
            },
            (error: unknown) => {
              outcome = { error };
            },
          );
          await awaitGateBeforeSettlement(
            inspecting,
            preparing,
            "Preparation settled before the integrity pause.",
          );
          // Deliberately end the genuine executor scope while the admitted preparation
          // is paused. The test still owns and joins that escaped operation below.
        });
        expect(original).toBeTypeOf("function");
        expect(() => original!()).toThrow();
      } finally {
        release();
        if (preparing) {
          await Promise.allSettled([preparing]);
        }
      }
      expect(outcome).toMatchObject({ error: expect.any(Error) });
      expect(onPrepared).not.toHaveBeenCalled();
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      expect(fs.existsSync(anchor)).toBe(false);
      expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
      expect(fs.existsSync(f.params.stage.packageRoot)).toBe(true);
      expect(read(f.launcher)).toBe("old launcher\n");
    }),
);
