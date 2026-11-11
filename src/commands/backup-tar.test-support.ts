import * as tar from "tar";

export function encodeTarEntry(params: {
  path: string;
  contents?: string | Uint8Array;
  type?: "File" | "Directory" | "Link" | "SymbolicLink";
  linkpath?: string;
  mode?: number;
}): Buffer {
  const body =
    typeof params.contents === "string"
      ? Buffer.from(params.contents, "utf8")
      : Buffer.from(params.contents ?? []);
  const type = params.type ?? "File";
  const header = new tar.Header({
    path: params.path,
    type,
    size: type === "File" ? body.length : 0,
    mode: params.mode ?? 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (type !== "File") {
    return headerBlock;
  }
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([headerBlock, body, padding]);
}
