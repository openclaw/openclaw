/**
 * Flatten pnpm virtual-store symlinks in a Next.js standalone output
 * into a standard flat node_modules layout.
 *
 * Why: pnpm's standalone output uses symlinks inside node_modules/ that
 * npm pack silently drops. Without this step the published package ships
 * with an empty node_modules/ and `require('next')` fails on user machines.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";

export interface FlattenResult {
  skipped: boolean;
  copied: number;
}

/**
 * Walk the pnpm `.pnpm/` virtual store inside `standaloneDir/node_modules/`
 * and copy every traced package (dereferenced) into a flat
 * `standaloneDir/apps/web/node_modules/` layout. Removes the root
 * `node_modules/` afterwards so only the self-contained app dir remains.
 */
export function flattenPnpmStandaloneDeps(standaloneDir: string): FlattenResult {
  const pnpmStore = path.join(standaloneDir, "node_modules", ".pnpm");
  const target = path.join(standaloneDir, "apps", "web", "node_modules");

  if (!existsSync(pnpmStore)) {
    return { skipped: true, copied: 0 };
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  let copied = 0;

  for (const storeEntry of readdirSync(pnpmStore)) {
    const nmDir = path.join(pnpmStore, storeEntry, "node_modules");
    if (!existsSync(nmDir)) continue;
    const stat = lstatSync(nmDir);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;

    let deps: string[];
    try {
      deps = readdirSync(nmDir);
    } catch {
      continue;
    }

    for (const dep of deps) {
      if (dep === ".pnpm" || dep === "node_modules") continue;
      const depPath = path.join(nmDir, dep);

      if (dep.startsWith("@")) {
        let scopedPkgs: string[];
        try {
          scopedPkgs = readdirSync(depPath);
        } catch {
          continue;
        }
        for (const pkg of scopedPkgs) {
          const src = path.join(depPath, pkg);
          const dst = path.join(target, dep, pkg);
          if (existsSync(dst)) continue;
          mkdirSync(path.join(target, dep), { recursive: true });
          cpSync(src, dst, { recursive: true, dereference: true, force: true });
          copied++;
        }
      } else {
        const dst = path.join(target, dep);
        if (existsSync(dst)) continue;
        cpSync(depPath, dst, {
          recursive: true,
          dereference: true,
          force: true,
        });
        copied++;
      }
    }
  }

  rmSync(path.join(standaloneDir, "node_modules"), {
    recursive: true,
    force: true,
  });

  return { skipped: false, copied };
}
