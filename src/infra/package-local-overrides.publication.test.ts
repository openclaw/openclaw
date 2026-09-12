import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  useLocalOverrideTestState,
  writePackageRoot,
} from "./package-local-overrides.test-support.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
useLocalOverrideTestState();
afterEach(() => vi.restoreAllMocks());

// Instrument the pinned dependency only inside each disposable child. Both wrappers
// invoke the real OS primitive, after creating the competing destination. Production
// uses the public durability API; no installed dependency files are changed.
function publicationFaultPreload(root: string, marker: string, scenario: string): string {
  const nativeUrl = new URL("native.js", import.meta.resolve("@openclaw/fs-safe/root")).href;
  return `
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { __setNativeLoaderForTest, __loadBundledNativeForTest } from ${JSON.stringify(nativeUrl)};
import { __setFsSafeTestHooksForTest } from ${JSON.stringify(import.meta.resolve("@openclaw/fs-safe/test-hooks"))};
const root=${JSON.stringify(root)}, marker=${JSON.stringify(marker)}, scenario=${JSON.stringify(scenario)};
const index=path.join(root,'dist/index.js');
function inject(source,target) {
  if (scenario==='publish-race' && path.basename(source).startsWith('.openclaw-override-next-') && target===index && !fsSync.existsSync(marker)) {
    fsSync.writeFileSync(index,'concurrent destination\\n',{flag:'wx'}); fsSync.writeFileSync(marker,'publication');
  }
  if (scenario==='restore-race') {
    if(source===index && path.basename(target).startsWith('.openclaw-override-previous-') && !fsSync.existsSync(marker)) {
      fsSync.writeFileSync(index,'concurrent source\\n'); fsSync.writeFileSync(marker,'retained');
    } else if(path.basename(source).startsWith('.openclaw-override-previous-') && target===index && fsSync.readFileSync(marker,'utf8')==='retained') {
      fsSync.writeFileSync(index,'concurrent destination\\n',{flag:'wx'}); fsSync.writeFileSync(marker,'restoration');
    }
  }
}
const rename=fs.rename.bind(fs);
fs.rename=async (source,target)=>{inject(String(source),String(target));return rename(source,target)};
__setNativeLoaderForTest(()=>{
  const binding=__loadBundledNativeForTest();
  const nativeRename=binding.renameNoReplace.bind(binding);
  return {...binding,renameNoReplace:(sfd,source,tfd,target)=>{
    inject(path.join(root,'dist',source),path.join(root,'dist',target));
    return nativeRename(sfd,source,tfd,target);
  }};
});
__setFsSafeTestHooksForTest({beforePublishDirectorySync:(_method,target)=>{
  const matches=scenario==='published-sync' ? target===index : scenario==='retained-sync' && path.basename(target).startsWith('.openclaw-override-previous-');
  if(matches&&!fsSync.existsSync(marker)){fsSync.writeFileSync(marker,'sync failure');throw new Error('injected directory sync failure');}
}});
`;
}

describe("local override exclusive publication", () => {
  it.each(["publish-race", "restore-race", "retained-sync", "published-sync"])(
    "preserves newer bytes or restores the original after %s",
    async (scenario) => {
      await withTestDir({ prefix: "openclaw-override-publication-" }, async (base) => {
        const requestedRoot = path.join(base, "package");
        await writePackageRoot(requestedRoot, "1.0.0");
        const packageRoot = await fs.realpath(requestedRoot);
        const indexPath = path.join(packageRoot, "dist/index.js");
        await fs.writeFile(indexPath, "operator override\n");
        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        const marker = path.join(base, "injected");
        const preload = `data:text/javascript,${encodeURIComponent(publicationFaultPreload(packageRoot, marker, scenario))}`;
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
          if (file !== process.execPath || !args?.includes("--eval")) {
            throw new Error("Unexpected child process in replay publication test");
          }
          return actual.execFile(file, ["--import", preload, ...args], options, callback);
        });
        const result = await applyLocalPackageOverrides({ packageRoot, plan, reapply: true });
        const injected = await fs.readFile(marker, "utf8");
        expect(injected).toBe(
          scenario === "publish-race"
            ? "publication"
            : scenario === "restore-race"
              ? "restoration"
              : "sync failure",
        );
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          scenario.endsWith("race") ? "concurrent destination\n" : "export {};\n",
        );
        if (scenario === "restore-race") {
          const entries = await fs.readdir(path.dirname(indexPath));
          const previous = entries.find((entry) =>
            entry.startsWith(".openclaw-override-previous-"),
          );
          if (!previous) {
            throw new Error("Concurrent source was not retained for recovery");
          }
          await expect(
            fs.readFile(path.join(path.dirname(indexPath), previous), "utf8"),
          ).resolves.toBe("concurrent source\n");
        }
      });
    },
  );
});
