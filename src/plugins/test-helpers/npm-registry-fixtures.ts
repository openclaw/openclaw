import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { clean } from "semver";
import type { Deferred } from "../../shared/deferred.js";

type PackageMetadata = {
  dependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type PackedVersion = PackageMetadata & {
  archive: Buffer;
  integrity: string;
  shasum: string;
  tarballName: string;
  version: string;
};

type PackPluginParams = PackageMetadata & {
  hookName?: string;
  indexJs?: string;
  manifest?: Record<string, unknown>;
  packageName: string;
  pluginId?: string;
  version?: string;
};

type RegistryInput = PackPluginParams & { latest?: string; omitIntegrity?: boolean };
type DownloadBarrier = { requested: Deferred; released: Deferred };

export type RegistryPackage = {
  latest: string;
  omitIntegrity?: boolean;
  packageName: string;
  versions: PackedVersion[];
};

function writeJson(filePath: string, value: unknown) {
  return fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function packPlugins(
  rootDir: string,
  packages: [PackPluginParams, ...PackPluginParams[]],
): Promise<PackedVersion[]> {
  const prepared = [];
  for (const params of packages) {
    const version = params.version ?? "1.0.0";
    const packageDir = path.join(rootDir, `package-${params.packageName}-${version}`);
    const distDir = path.join(packageDir, "dist");
    const peerDependenciesMeta = params.peerDependencies
      ? (params.peerDependenciesMeta ??
        Object.fromEntries(
          Object.keys(params.peerDependencies).map((name) => [name, { optional: true }]),
        ))
      : undefined;
    await fs.mkdir(distDir, { recursive: true });
    await writeJson(path.join(packageDir, "package.json"), {
      name: params.packageName,
      version,
      type: "module",
      openclaw:
        params.openclaw ??
        (params.hookName
          ? { hooks: [`./hooks/${params.hookName}`] }
          : { extensions: ["./dist/index.js"] }),
      dependencies: params.dependencies,
      optionalDependencies: params.optionalDependencies,
      peerDependencies: params.peerDependencies,
      peerDependenciesMeta,
    });
    if (params.hookName) {
      const hookDir = path.join(packageDir, "hooks", params.hookName);
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        `---\nname: ${params.hookName}\ndescription: Install cancellation fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n`,
      );
      await fs.writeFile(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    } else {
      await writeJson(path.join(packageDir, "openclaw.plugin.json"), {
        id: params.pluginId ?? params.packageName,
        name: params.pluginId ?? params.packageName,
        configSchema: { type: "object" },
        ...params.manifest,
      });
    }
    await fs.writeFile(path.join(distDir, "index.js"), params.indexJs ?? "export {};\n", "utf8");
    prepared.push({ params, packageDir, peerDependenciesMeta, version });
  }

  const packageDirs = prepared.map(({ packageDir }) => packageDir);
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", rootDir, ...packageDirs], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const versions: PackedVersion[] = [];
  const packedFiles = new Set(await fs.readdir(rootDir));
  for (const { params, peerDependenciesMeta, version } of prepared) {
    // npm 12 collapses versions in JSON output; archive names may use raw or normalized versions.
    const normalized = expectDefined(clean(version, { loose: true }), "packed fixture version");
    const tarballNames = [...new Set([version, normalized])]
      .map((value) => `${params.packageName.replace(/^@/, "").replaceAll("/", "-")}-${value}.tgz`)
      .filter((name) => packedFiles.has(name));
    if (tarballNames.length !== 1) {
      throw new Error(`Expected one packed archive for ${params.packageName}@${version}`);
    }
    const tarballName = expectDefined(tarballNames[0], "packed fixture archive");
    const archive = await fs.readFile(path.join(rootDir, tarballName));
    versions.push({
      archive,
      ...(params.dependencies ? { dependencies: params.dependencies } : {}),
      integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
      ...(params.openclaw ? { openclaw: params.openclaw } : {}),
      ...(params.optionalDependencies ? { optionalDependencies: params.optionalDependencies } : {}),
      ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
      ...(peerDependenciesMeta ? { peerDependenciesMeta } : {}),
      shasum: crypto.createHash("sha1").update(archive).digest("hex"),
      tarballName,
      version,
    });
  }
  return versions;
}

export async function registryPackages(
  rootDir: string,
  packages: [RegistryInput, ...RegistryInput[]],
): Promise<RegistryPackage[]> {
  const versions = await packPlugins(rootDir, packages);
  return packages.map((params, index) => ({
    packageName: params.packageName,
    latest: params.latest ?? params.version ?? "1.0.0",
    ...(params.omitIntegrity ? { omitIntegrity: true } : {}),
    versions: [expectDefined(versions[index], "packed fixture version")],
  }));
}

export async function startStaticRegistry(
  packages: RegistryPackage[],
  servers: http.Server[],
  downloadBarrier?: DownloadBarrier,
): Promise<string> {
  return startRegistry(packages, servers, { downloadBarrier });
}

async function startRegistry(
  packages: RegistryPackage[],
  servers: http.Server[],
  options: { downloadBarrier?: DownloadBarrier; nextLatest?: string },
): Promise<string> {
  const { downloadBarrier, nextLatest } = options;
  const packageEntries = packages.map((pkg) => ({
    ...pkg,
    encodedPackageName: encodeURIComponent(pkg.packageName).replace("%40", "@"),
    versionsByVersion: new Map(pkg.versions.map((entry) => [entry.version, entry])),
  }));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("method not allowed");
      return;
    }
    if (downloadBarrier && url.pathname === "/-/test/authority-close") {
      void downloadBarrier.requested.promise.then(() => response.end("close"));
      return;
    }
    if (downloadBarrier && url.pathname === "/-/test/authority-closed") {
      downloadBarrier.released.resolve();
      response.end("closed");
      return;
    }

    for (const pkg of packageEntries) {
      if (decodeURIComponent(url.pathname) === `/${pkg.packageName}`) {
        const latest = pkg.latest;
        if (nextLatest !== undefined) {
          pkg.latest = nextLatest;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify({
            name: pkg.packageName,
            "dist-tags": { latest },
            versions: Object.fromEntries(
              [...pkg.versionsByVersion.entries()].map(([version, entry]) => [
                version,
                {
                  name: pkg.packageName,
                  version,
                  openclaw: entry.openclaw,
                  // Preserve the mutable registry's narrower packument.
                  dependencies: nextLatest === undefined ? entry.dependencies : undefined,
                  optionalDependencies:
                    nextLatest === undefined ? entry.optionalDependencies : undefined,
                  peerDependencies: entry.peerDependencies,
                  peerDependenciesMeta: entry.peerDependenciesMeta,
                  dist: {
                    ...(pkg.omitIntegrity ? {} : { integrity: entry.integrity }),
                    shasum: entry.shasum,
                    tarball: `${baseUrl}/${pkg.encodedPackageName}/-/${entry.tarballName}`,
                  },
                },
              ]),
            ),
          })}\n`,
        );
        return;
      }

      const tarballPrefix = `/${pkg.encodedPackageName}/-/`;
      if (url.pathname.startsWith(tarballPrefix)) {
        const entry = [...pkg.versionsByVersion.values()].find((candidate) =>
          url.pathname.endsWith(`/${candidate.tarballName}`),
        );
        if (entry) {
          const sendArchive = () => {
            response.writeHead(200, {
              "content-length": String(entry.archive.length),
              "content-type": "application/octet-stream",
            });
            response.end(entry.archive);
          };
          if (downloadBarrier) {
            downloadBarrier.requested.resolve();
            void downloadBarrier.released.promise.then(sendArchive);
          } else {
            sendArchive();
          }
          return;
        }
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

export async function startMutableRegistry(
  params: {
    packageName: string;
    initialLatest: string;
    laterLatest: string;
    versions: PackedVersion[];
  },
  servers: http.Server[],
): Promise<string> {
  return startRegistry(
    [{ packageName: params.packageName, latest: params.initialLatest, versions: params.versions }],
    servers,
    { nextLatest: params.laterLatest },
  );
}
