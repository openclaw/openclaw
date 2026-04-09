import { Buffer } from "node:buffer";
import type WebSocket from "ws";

function isArrayBufferView(data: unknown): data is ArrayBufferView {
  return ArrayBuffer.isView(data);
}

function rawDataViewToBuffer(data: ArrayBufferView): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function rawDataToString(
  data: WebSocket.RawData | ArrayBufferView,
  encoding: BufferEncoding = "utf8",
): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString(encoding);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString(encoding);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString(encoding);
  }
  if (isArrayBufferView(data)) {
    return rawDataViewToBuffer(data).toString(encoding);
  }
  return Buffer.from(String(data)).toString(encoding);
}

export function rawDataByteLength(data: WebSocket.RawData | ArrayBufferView): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (isArrayBufferView(data)) {
    return data.byteLength;
  }
  return Buffer.byteLength(String(data));
}
