export { readRequestText as readRequestBody } from "../../test/helpers/gateway-integration-fixtures.js";
import type { ServerResponse } from "node:http";

export function writeTuiModelHttpJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}
