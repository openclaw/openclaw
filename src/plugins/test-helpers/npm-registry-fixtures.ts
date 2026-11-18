import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { clean } from "semver";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import type { Deferred } from "../../shared/deferred.js";

type PackageMetadata = {
  dependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type PackPluginParams = PackageMetadata & {
  hookName?: string;
  indexJs?: string;
  manifest?: Record<string, unknown>;
  packageName: string;
  pluginId?: string;
  version?: string;
};

type PackageInputs = [PackPluginParams, ...PackPluginParams[]];
type DownloadBarrier = { requested: Deferred; released: Deferred };

export type RegistryPackage = Awaited<ReturnType<typeof registryPackages>>[number];

async function writeFixture(root: string, name: string, value: unknown) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, content);
}

export async function packPlugins(rootDir: string, packages: PackageInputs) {
  const prepared = [];
  for (const {
    packageName,
    version = "1.0.0",
    pluginId = packageName,
    hookName,
    indexJs = "export {};\n",
    manifest,
    ...metadata
  } of packages) {
    const packageDir = path.join(rootDir, `package-${packageName}-${version}`);
    await writeFixture(packageDir, "package.json", {
      name: packageName,
      version,
      type: "module",
      ...metadata,
      openclaw:
        metadata.openclaw ??
        (hookName ? { hooks: [`./hooks/${hookName}`] } : { extensions: ["./dist/index.js"] }),
    });
    if (hookName) {
      const hookDir = path.join(packageDir, "hooks", hookName);
      const hookManifest = `---\nname: ${hookName}\ndescription: Install cancellation fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n`;
      await writeFixture(hookDir, "HOOK.md", hookManifest);
      await writeFixture(hookDir, "handler.js", "export default async () => {};\n");
    } else {
      await writeFixture(packageDir, "openclaw.plugin.json", {
        id: pluginId,
        name: pluginId,
        configSchema: { type: "object" },
        ...manifest,
      });
    }
    await writeFixture(packageDir, "dist/index.js", indexJs);
    prepared.push({ packageName, packageDir, metadata, version });
  }

  const packageDirs = prepared.map(({ packageDir }) => packageDir);
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", rootDir, ...packageDirs], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const versions = [];
  const packedFiles = new Set(await fs.readdir(rootDir));
  for (const { packageName, metadata, version } of prepared) {
    // npm 12 collapses versions in JSON output; archive names may use raw or normalized versions.
    const normalized = expectDefined(clean(version, { loose: true }), "packed fixture version");
    const [tarballName, ...extraTarballs] = [...new Set([version, normalized])]
      .map((value) => `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${value}.tgz`)
      .filter((name) => packedFiles.has(name));
    if (!tarballName || extraTarballs.length) {
      throw new Error(`Expected one packed archive for ${packageName}@${version}`);
    }
    const archive = await fs.readFile(path.join(rootDir, tarballName));
    const integrity = `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`;
    versions.push({ archive, metadata, integrity, tarballName, version });
  }
  return versions;
}

export async function registryPackages(rootDir: string, packages: PackageInputs) {
  const versions = await packPlugins(rootDir, packages);
  return packages.map((params, index) => ({
    packageName: params.packageName,
    latest: params.version ?? "1.0.0",
    versions: [expectDefined(versions[index], "packed fixture version")],
  }));
}

export async function startStaticRegistry(
  packages: RegistryPackage[],
  servers: http.Server[],
  downloadBarrier?: DownloadBarrier,
  nextLatest?: string,
): Promise<string> {
  const packageEntries = packages.map((pkg) => ({
    ...pkg,
    encodedPackageName: encodeURIComponent(pkg.packageName).replace("%40", "@"),
    versionsByVersion: new Map(pkg.versions.map((entry) => [entry.version, entry])),
  }));
  const respond = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const pathname = new URL(request.url ?? "/", baseUrl).pathname;
    const send = (body: string | Buffer | object, code = 200) => {
      const binary = Buffer.isBuffer(body);
      response.writeHead(code, {
        "content-type": binary
          ? "application/octet-stream"
          : typeof body === "string"
            ? "text/plain"
            : "application/json",
        ...(binary ? { "content-length": String(body.length) } : {}),
      });
      response.end(binary || typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
    };
    if (request.method !== "GET") {
      return send("method not allowed", 405);
    }
    if (downloadBarrier && pathname === "/-/test/authority-close") {
      await downloadBarrier.requested.promise;
      return send("close");
    }
    if (downloadBarrier && pathname === "/-/test/authority-closed") {
      downloadBarrier.released.resolve();
      return send("closed");
    }

    for (const pkg of packageEntries) {
      if (decodeURIComponent(pathname) === `/${pkg.packageName}`) {
        const latest = pkg.latest;
        pkg.latest = nextLatest ?? latest;
        return send({
          name: pkg.packageName,
          "dist-tags": { latest },
          versions: Object.fromEntries(
            [...pkg.versionsByVersion].map(([version, entry]) => {
              const dist = {
                integrity: entry.integrity,
                tarball: `${baseUrl}/${pkg.encodedPackageName}/-/${entry.tarballName}`,
              };
              return [version, { name: pkg.packageName, version, ...entry.metadata, dist }];
            }),
          ),
        });
      }

      const tarballPrefix = `/${pkg.encodedPackageName}/-/`;
      if (pathname.startsWith(tarballPrefix)) {
        const entry = [...pkg.versionsByVersion.values()].find((candidate) =>
          pathname.endsWith(`/${candidate.tarballName}`),
        );
        if (entry) {
          if (downloadBarrier) {
            downloadBarrier.requested.resolve();
            await downloadBarrier.released.promise;
          }
          return send(entry.archive);
        }
      }
    }

    return send(`not found: ${pathname}`, 404);
  };
  const server = http.createServer((request, response) => {
    void respond(request, response);
  });
  const baseUrl = await listenLoopback(server);
  servers.push(server);
  return baseUrl;
}

export async function startMutableRegistry(
  params: Pick<RegistryPackage, "packageName" | "versions"> & {
    initialLatest: string;
    laterLatest: string;
  },
  servers: http.Server[],
): Promise<string> {
  return startStaticRegistry(
    [{ packageName: params.packageName, latest: params.initialLatest, versions: params.versions }],
    servers,
    undefined,
    params.laterLatest,
  );
}
