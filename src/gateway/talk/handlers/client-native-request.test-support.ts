import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { upstream } from "./client-native-control.test-support.js";

type NativeCallSession = {
  instructions: string;
  initial_items?: unknown;
  delegation?: Record<string, unknown>;
};

function isNativeCallSession(value: unknown): value is NativeCallSession {
  return (
    isRecord(value) &&
    typeof value.instructions === "string" &&
    (value.delegation === undefined || isRecord(value.delegation))
  );
}

export async function nativeCallSession(): Promise<NativeCallSession> {
  const init = upstream.fetch.mock.calls.at(-1)?.[1];
  if (!init) {
    throw new Error("Missing native call request");
  }
  const form = await new Request("https://example.test", {
    method: "POST",
    headers: init.headers,
    body: init.body,
  }).formData();
  const sessionJson = form.get("session");
  if (typeof sessionJson !== "string") {
    throw new Error("Missing native call session");
  }
  const session: unknown = JSON.parse(sessionJson);
  if (!isNativeCallSession(session)) {
    throw new Error("Invalid native call session");
  }
  return session;
}
