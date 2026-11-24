import fs from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";

export function copyInitialCa(sourceDir: string, targetDir: string): void {
  for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  }
}

export function basicProxyAuth(password: string): string {
  return `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;
}

export const registeredPassword = (env: Record<string, string>) =>
  new URL(env.HTTPS_PROXY ?? "").password;

export async function readProxyResponse(
  socket: Socket,
  headersOnly = false,
  onContinue?: () => void,
) {
  let output = "";
  if (!headersOnly) {
    socket.setEncoding("utf8");
  }
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    output += chunk.toString();
    if (output.startsWith("HTTP/1.1 100 Continue\r\n\r\n")) {
      onContinue?.();
    }
    const headEnd = output.indexOf("\r\n\r\n");
    const length = /(?:^|\r\n)content-length:\s*(\d+)/iu.exec(output.slice(0, headEnd));
    if (
      headEnd >= 0 &&
      (headersOnly || (length && Buffer.byteLength(output.slice(headEnd + 4)) >= Number(length[1])))
    ) {
      return output;
    }
  }
  return output;
}

// Raw upstream bytes: Node's own server cannot emit a Content-Length before a
// UTF-8 Content-Disposition, which is the order real upstreams commonly send.
export const RAW_UPSTREAM_RESPONSES = new Map<string, Buffer>([
  [
    "/cjk-attachment",
    Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Disposition: attachment; "),
      Buffer.from('filename="附件_2026-09-21.log"', "utf8"),
      Buffer.from("\r\nConnection: close\r\n\r\nfile"),
    ]),
  ],
  [
    "/invalid-trailer",
    Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTrailer: Expires\r\nConnection: close\r\n\r\nfile",
    ),
  ],
]);
