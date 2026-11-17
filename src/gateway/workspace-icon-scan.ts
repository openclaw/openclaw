// Worker-owned icon discovery; descriptors never leave the scanning isolate.
import { close } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { openRootFile, readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import {
  HTTP_IMAGE_MAX_BYTES,
  HTTP_SVG_MAX_BYTES,
  resolveHttpImageRepresentation,
  type HttpImageRepresentation,
} from "./http-image-response.js";

export const WORKSPACE_ICON_MAX_BYTES = HTTP_IMAGE_MAX_BYTES;
export const SVG_ICON_MAX_BYTES = HTTP_SVG_MAX_BYTES;
export type WorkspaceIconSnapshot = Omit<HttpImageRepresentation, "body"> & {
  body: Uint8Array<ArrayBuffer>;
};
type WorkspaceIconResolution = HttpImageRepresentation | null;
const closeFileDescriptor = promisify(close);

/**
 * Conventional project icon locations in deterministic product precedence.
 * Resolution stops at the first valid hit, so this fixed list is the whole
 * filesystem cost of opening a workspace and never becomes a recursive scan.
 */
const WORKSPACE_ICON_RELATIVE_PATHS = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/favicon-32.png",
  "public/apple-touch-icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "ui/public/favicon-32.png",
  "ui/public/favicon.svg",
  "ui/public/favicon.ico",
  "ui/public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

export async function scanWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  for (const relativePath of WORKSPACE_ICON_RELATIVE_PATHS) {
    const opened = await openRootFile({
      absolutePath: path.join(workspaceRoot, relativePath),
      rootPath: workspaceRoot,
      boundaryLabel: "workspace root",
      symlinks: "follow-parents-within-root",
      maxBytes: WORKSPACE_ICON_MAX_BYTES,
    });
    if (!opened.ok) {
      continue;
    }
    let body: Buffer;
    try {
      body = await readFileDescriptorBounded(opened.fd, WORKSPACE_ICON_MAX_BYTES);
    } catch {
      continue;
    } finally {
      await closeFileDescriptor(opened.fd);
    }
    const icon = await resolveHttpImageRepresentation(relativePath, body);
    if (icon) {
      return icon;
    }
  }
  return null;
}
