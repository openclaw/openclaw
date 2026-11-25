import { createHash } from "node:crypto";
import { createServer } from "node:http";
import JSZip from "jszip";
import {
  readRequestText as readRequestBody,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { clawHubSecurityResponse } from "../plugins/clawhub.test-fixtures.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";

export type ClawHubFixtureOptions = {
  name: string;
  id: string;
  version: string;
  files: Record<string, string | Buffer>;
  artifactSha256?: string;
  artifactCompatibility?: Record<string, string> | null;
  packageCompatibility?: Record<string, string>;
  telemetryStatus?: number;
};

export async function startClawHubPackageFixture(options: ClawHubFixtureOptions) {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(options.files)) {
    zip.file(`package/${name}`, contents);
  }
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const sha256hash = options.artifactSha256 ?? createHash("sha256").update(archive).digest("hex");
  const pkg = { name: options.name, family: "code-plugin" as const };
  const packagePath = `/api/v1/packages/${encodeURIComponent(options.name)}`;
  const versionPath = `${packagePath}/versions/${options.version}`;
  const requests: string[] = [];
  const telemetry: unknown[] = [];
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        requests.push(`${request.method} ${pathname}`);
        void (async () => {
          if (request.method === "POST" && pathname === "/api/cli/telemetry/install") {
            telemetry.push(JSON.parse(await readRequestBody(request)));
            const status = options.telemetryStatus ?? 200;
            respondJson(response, status === 200 ? { ok: true } : { error: "down" }, status);
            return;
          }
          if (request.method === "GET" && pathname === `${packagePath}/download`) {
            response.writeHead(200, { "content-type": "application/zip" }).end(archive);
            return;
          }
          const routes: Record<string, unknown> = {
            [packagePath]: {
              package: {
                ...pkg,
                runtimeId: options.id,
                latestVersion: options.version,
                compatibility: options.packageCompatibility ?? {},
              },
            },
            [`${versionPath}/artifact`]: {
              version: {
                version: options.version,
                sha256hash,
                ...(options.artifactCompatibility === null
                  ? {}
                  : { compatibility: options.artifactCompatibility ?? {} }),
              },
            },
            [`${versionPath}/security`]: {
              ...clawHubSecurityResponse(options.name, options.version),
              securityAuditUrl: `http://${request.headers.host}${versionPath}/security`,
            },
          };
          if (request.method === "GET" && Object.hasOwn(routes, pathname)) {
            respondJson(response, routes[pathname]);
          } else {
            response.writeHead(404).end("unknown fixture route");
          }
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      }),
  });
  return {
    url: `http://127.0.0.1:${reservation.claim.port}`,
    requests,
    telemetry,
    async close() {
      await reservation.releaseListener();
      await reservation.claim.release();
    },
  };
}
