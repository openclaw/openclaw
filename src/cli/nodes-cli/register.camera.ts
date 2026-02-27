import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { renderTable } from "../../terminal/table.js";
import { shortenHomePath } from "../../utils.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
  writeCameraClipPayloadToFile,
  writeUrlToFile,
} from "../nodes-camera.js";
import { parseDurationMs } from "../parse-duration.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { buildNodeInvokeParams, callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const parseFacing = (value: string): CameraFacing => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "front" || v === "back") {
    return v;
  }
  throw new Error(`invalid facing: ${value} (expected front|back)`);
};

export function registerNodesCameraCommands(nodes: Command) {
  const camera = nodes.command("camera").description("Capture camera media from a paired node");

  nodesCallOpts(
    camera
      .command("list")
      .description("List available cameras on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera list", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const raw = await callGatewayCli(
            "node.invoke",
            opts,
            buildNodeInvokeParams({
              nodeId,
              command: "camera.list",
              params: {},
            }),
          );

          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload =
            typeof res.payload === "object" && res.payload !== null
              ? (res.payload as { devices?: unknown })
              : {};
          const devices = Array.isArray(payload.devices) ? payload.devices : [];

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(devices, null, 2));
            return;
          }

          if (devices.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No cameras reported."));
            return;
          }

          const { heading, muted } = getNodesTheme();
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          const rows = devices.map((device) => ({
            Name: typeof device.name === "string" ? device.name : "Unknown Camera",
            Position: typeof device.position === "string" ? device.position : muted("unspecified"),
            ID: typeof device.id === "string" ? device.id : "",
          }));
          defaultRuntime.log(heading("Cameras"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Name", header: "Name", minWidth: 14, flex: true },
                { key: "Position", header: "Position", minWidth: 10 },
                { key: "ID", header: "ID", minWidth: 10, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("snap")
      .description("Capture a photo from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back|both>", "Camera facing", "both")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (default 0.9)")
      .option("--delay-ms <ms>", "Delay before capture in ms (macOS default 2000)")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera snap", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facingOpt = String(opts.facing ?? "both")
            .trim()
            .toLowerCase();
          const facings: CameraFacing[] =
            facingOpt === "both"
              ? ["front", "back"]
              : facingOpt === "front" || facingOpt === "back"
                ? [facingOpt]
                : (() => {
                    throw new Error(
                      `invalid facing: ${String(opts.facing)} (expected front|back|both)`,
                    );
                  })();

          const maxWidth = opts.maxWidth ? Number.parseInt(String(opts.maxWidth), 10) : undefined;
          const quality = opts.quality ? Number.parseFloat(String(opts.quality)) : undefined;
          const delayMs = opts.delayMs ? Number.parseInt(String(opts.delayMs), 10) : undefined;
          const deviceId = opts.deviceId ? String(opts.deviceId).trim() : undefined;
          if (deviceId && facings.length > 1) {
            throw new Error("facing=both is not allowed when --device-id is set");
          }
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const results: Array<{
            facing: CameraFacing;
            path: string;
            width: number;
            height: number;
          }> = [];

          for (const facing of facings) {
            const invokeParams = buildNodeInvokeParams({
              nodeId,
              command: "camera.snap",
              params: {
                facing,
                maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
                quality: Number.isFinite(quality) ? quality : undefined,
                format: "jpg",
                delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
                deviceId: deviceId || undefined,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const res =
              typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
            const payload = parseCameraSnapPayload(res.payload);
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
            });
            if (payload.url) {
              await writeUrlToFile(filePath, payload.url);
            } else if (payload.base64) {
              await writeBase64ToFile(filePath, payload.base64);
            }
            results.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ files: results }, null, 2));
            return;
          }
          defaultRuntime.log(results.map((r) => `MEDIA:${shortenHomePath(r.path)}`).join("\n"));
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("clip")
      .description("Capture a short video clip from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back>", "Camera facing", "front")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option(
        "--duration <ms|10s|1m>",
        "Duration (default 3000ms; supports ms/s/m, e.g. 10s)",
        "3000",
      )
      .option("--no-audio", "Disable audio capture")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 90000)", "90000")
      .action(async (opts: NodesRpcOpts & { audio?: boolean }) => {
        await runNodesCommand("camera clip", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facing = parseFacing(String(opts.facing ?? "front"));
          const durationMs = parseDurationMs(String(opts.duration ?? "3000"));
          const includeAudio = opts.audio !== false;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;
          const deviceId = opts.deviceId ? String(opts.deviceId).trim() : undefined;

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              includeAudio,
              format: "mp4",
              deviceId: deviceId || undefined,
            },
            timeoutMs,
          });

          const raw = await callGatewayCli("node.invoke", opts, invokeParams);
          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload = parseCameraClipPayload(res.payload);
          const filePath = await writeCameraClipPayloadToFile({
            payload,
            facing,
          });

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    facing,
                    path: filePath,
                    durationMs: payload.durationMs,
                    hasAudio: payload.hasAudio,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
        });
      }),
    { timeoutMs: 90_000 },
  );
}
