import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent, fetch } from "undici";
import { expect, test, vi } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

test("downloads inline artifacts over authenticated WSS and HTTPS with live ticket authority", async () => {
  await withOpenClawTestState(
    {
      label: "artifact-https-download",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
    },
    async (state) => {
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const token = "synthetic-artifact-https-token";
      const certPath = state.statePath("tls", "cert.pem");
      const keyPath = state.statePath("tls", "key.pem");
      const sessionKey = "agent:main:artifact-https";
      const sessionId = "artifact-https-session";
      const runId = "artifact-https-run";
      const taskId = "artifact-https-task";
      const scope = { agentId: "main", sessionKey, sessionId, env: state.env };
      const binary = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 256));
      const fixtures = [
        {
          title: "binary.bin",
          type: "file",
          mimeType: "application/octet-stream",
          bytes: binary,
          sizeBytes: 1,
        },
        {
          title: "drawing.svg",
          type: "image",
          mimeType: "image/svg+xml",
          bytes: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><text>synthetic</text></svg>',
          ),
        },
        {
          title: "empty.bin",
          type: "file",
          mimeType: "application/octet-stream",
          bytes: Buffer.alloc(0),
        },
      ];
      const timestamp = new Date().toISOString();
      const events = [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: state.workspaceDir },
        {
          type: "message",
          id: "inline-artifacts",
          parentId: null,
          timestamp,
          message: {
            role: "assistant",
            content: fixtures.map((fixture) => ({
              type: fixture.type,
              title: fixture.title,
              mimeType: fixture.mimeType,
              ...(fixture.sizeBytes !== undefined ? { sizeBytes: fixture.sizeBytes } : {}),
              ...(fixture.type === "image"
                ? {
                    source: {
                      type: "base64",
                      media_type: fixture.mimeType,
                      data: fixture.bytes.toString("base64"),
                    },
                  }
                : { data: fixture.bytes.toString("base64") }),
            })),
            __openclaw: { id: "inline-artifacts", runId, messageTaskId: taskId },
          },
        },
      ];
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let dispatcher: Agent | undefined;
      const clients: GatewayClient[] = [];
      await runQaGatewayFixture(
        async () => {
          await state.writeConfig({
            agents: { defaults: { workspace: state.workspaceDir } },
            gateway: {
              auth: { mode: "token", token },
              controlUi: { enabled: false, basePath: "/gateway" },
              tls: { enabled: true, certPath, keyPath },
            },
          });
          await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
          await replaceTranscriptEvents(scope, events);
          server = await startClaimedGateway(claim, () =>
            startGatewayServer(claim.port, {
              bind: "loopback",
              auth: { mode: "token", token },
              controlUiEnabled: false,
              sidecarStartup: "defer",
            }),
          );
          const cert = await readFile(certPath, "utf8");
          dispatcher = new Agent({ connect: { ca: cert, servername: "openclaw-gateway" } });
          const origin = `https://127.0.0.1:${claim.port}`;
          const connect = async (label: string, scopes: string[]) => {
            const client = await acquireGatewayTestClient(
              {
                url: `wss://127.0.0.1:${claim.port}`,
                token,
                tlsFingerprint: new X509Certificate(cert).fingerprint256,
                clientName: "test",
                mode: "test",
                scopes,
                deviceIdentity: loadOrCreateDeviceIdentity({
                  path: state.statePath(`${label}.sqlite`),
                }),
              },
              {
                timeoutMs: 10_000,
                timeoutMessage: "TLS Gateway connect timed out",
                closeMessage: "TLS Gateway closed",
              },
            );
            clients.push(client);
            return client;
          };
          const client = await connect("reader", ["operator.read"]);
          const query = { sessionKey, runId, taskId, messageRole: "assistant" };
          const listed = await client.request<ArtifactsListResult>("artifacts.list", query);
          expect(listed.artifacts).toHaveLength(fixtures.length);
          const request = async (
            url: string,
            init: { method?: string; headers?: Record<string, string> } = {},
          ) => {
            const response = await fetch(new URL(url, origin), { ...init, dispatcher });
            return {
              status: response.status,
              headers: response.headers,
              bytes: Buffer.from(await response.arrayBuffer()),
            };
          };
          const downloads: ArtifactsDownloadResult[] = [];
          for (const fixture of fixtures) {
            const artifact = listed.artifacts.find((entry) => entry.title === fixture.title);
            expect(artifact).toBeDefined();
            if (fixture.sizeBytes !== undefined) {
              expect(artifact!.sizeBytes).toBe(fixture.sizeBytes);
            }
            const params = { ...query, artifactId: artifact!.id };
            const inline = await client.request<ArtifactsDownloadResult>(
              "artifacts.download",
              params,
            );
            expect(inline.artifact.download.mode).toBe("bytes");
            expect(inline.encoding).toBe("base64");
            expect(inline.url).toBeUndefined();
            expect(Buffer.from(inline.data!, "base64")).toEqual(fixture.bytes);

            const download = await client.request<ArtifactsDownloadResult>("artifacts.download", {
              ...params,
              transport: "http",
            });
            expect(download.artifact.download.mode).toBe("url");
            expect(download.data).toBeUndefined();
            expect(download.encoding).toBeUndefined();
            expect(download.url?.startsWith("/api/artifacts/download/")).toBe(true);
            expect(Date.parse(download.expiresAt!)).toBeGreaterThan(Date.now());
            downloads.push(download);
            const body = await request(download.url!);
            expect(body.status).toBe(200);
            expect(body.headers.get("content-type")).toBe(fixture.mimeType);
            expect(body.headers.get("content-length")).toBe(String(fixture.bytes.length));
            expect(body.headers.get("content-disposition")).toContain("attachment;");
            expect(body.headers.get("content-disposition")).toContain(fixture.title);
            expect(body.headers.get("x-content-type-options")).toBe("nosniff");
            expect(body.headers.get("content-security-policy")).toContain("sandbox");
            expect(body.bytes).toEqual(fixture.bytes);
            const head = await request(download.url!, { method: "HEAD" });
            expect(head.status).toBe(200);
            expect(head.headers.get("content-length")).toBe(String(fixture.bytes.length));
            expect(head.bytes.length).toBe(0);
          }

          const download = downloads[0]!;
          const url = download.url!;
          const mounted = await request(`/gateway${url}`);
          expect(mounted.status, "the artifact route works below the configured mount").toBe(200);
          expect(mounted.bytes).toEqual(binary);
          const ranged = await request(url, { headers: { Range: "bytes=253-258" } });
          expect(ranged.status).toBe(206);
          expect(ranged.headers.get("content-length")).toBe("6");
          expect(ranged.headers.get("content-range")).toBe(`bytes 253-258/${binary.length}`);
          expect(ranged.bytes).toEqual(binary.subarray(253, 259));
          const outOfRange = await request(url, { headers: { Range: "bytes=8192-" } });
          expect(outOfRange.status).toBe(416);
          expect(outOfRange.headers.get("content-range")).toBe(`bytes */${binary.length}`);
          expect((await request(url, { method: "POST" })).status).toBe(405);
          const tamperedUrl = `${url.slice(0, -1)}${url.endsWith("a") ? "b" : "a"}`;
          expect((await request(tamperedUrl)).status).toBe(404);
          expect((await request("/api/artifacts/download/missing/missing")).status).toBe(404);

          const underscoped = await connect("approver", ["operator.approvals"]);
          await expect(
            underscoped.request("artifacts.download", {
              ...query,
              artifactId: download.artifact.id,
              transport: "http",
            }),
          ).rejects.toThrow("missing scope: operator.read");
          await expect(
            client.request("artifacts.download", {
              ...query,
              runId: "unrelated-run",
              artifactId: download.artifact.id,
              transport: "http",
            }),
          ).rejects.toMatchObject({ details: { type: "artifact_not_found" } });

          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(download.expiresAt!) + 1);
          try {
            expect((await request(url)).status).toBe(404);
          } finally {
            clock.mockRestore();
          }
          const renewed = await client.request<ArtifactsDownloadResult>("artifacts.download", {
            ...query,
            artifactId: download.artifact.id,
            transport: "http",
          });
          const replacement = Buffer.from(binary);
          replacement[0] = 255;
          const replacedEvents = events.map((event) =>
            event.message
              ? {
                  ...event,
                  message: {
                    ...event.message,
                    content: event.message.content.map((block, index) =>
                      index === 0 ? { ...block, data: replacement.toString("base64") } : block,
                    ),
                  },
                }
              : event,
          );
          await replaceTranscriptEvents(scope, replacedEvents);
          const staleRequests: Array<[string, Parameters<typeof request>[1]]> = [
            ["GET", {}],
            ["HEAD", { method: "HEAD" }],
            ["range", { headers: { Range: "bytes=253-258" } }],
            ["conditional GET", { headers: { "If-None-Match": "*" } }],
          ];
          for (const [label, init] of staleRequests) {
            expect(
              (await request(renewed.url!, init)).status,
              `${label} must reject replaced bytes under the same artifact ID`,
            ).toBe(404);
          }
          const replaced = await client.request<ArtifactsDownloadResult>("artifacts.download", {
            ...query,
            artifactId: download.artifact.id,
            transport: "http",
          });
          expect(replaced.artifact.id).toBe(download.artifact.id);
          const replacedBody = await request(replaced.url!);
          expect(replacedBody.status).toBe(200);
          expect(replacedBody.bytes).toEqual(replacement);
          await replaceTranscriptEvents(scope, events);
          const beforeRemoval = await client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            {
              ...query,
              artifactId: download.artifact.id,
              transport: "http",
            },
          );
          await replaceTranscriptEvents(scope, []);
          expect(
            (await request(beforeRemoval.url!)).status,
            "removing the artifact from its transcript revokes its download",
          ).toBe(404);
          await replaceTranscriptEvents(scope, events);
          const beforeDisconnect = await client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            { ...query, artifactId: download.artifact.id, transport: "http" },
          );
          await client.stopAndWait();
          expect((await request(beforeDisconnect.url!)).status).toBe(404);
        },
        async () => {
          for (const client of clients) {
            await client.stopAndWait();
          }
        },
        async () => {
          await dispatcher?.close();
        },
        async () => {
          await server?.close({ reason: "artifact HTTPS proof complete" });
        },
        () => claim.release(),
      );
    },
  );
}, 60_000);
