import { describe, expect, it } from "vitest";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseBytes,
  readBoundedResponseText,
} from "../../scripts/lib/bounded-response.mjs";

function responseProbe(headers: Headers, readsBody = false) {
  const state = { readStarted: false, canceled: false };
  const cancel = async () => {
    state.canceled = true;
  };
  const response = {
    headers,
    body: {
      cancel,
      getReader: () => ({
        async read() {
          state.readStarted = true;
          return readsBody
            ? { done: false, value: new Uint8Array(17) }
            : new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
        },
        cancel,
        releaseLock() {},
      }),
    },
  } as unknown as Response;
  return { response, state };
}

describe("scripts bounded response reader", () => {
  it("preserves binary response bytes", async () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x7f]);

    await expect(
      readBoundedResponseBytes(new Response(body), "fixture", body.length),
    ).resolves.toEqual(body);
  });

  it("decodes multibyte text split across chunks", async () => {
    const encoded = new TextEncoder().encode("a😀b");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 3));
          controller.enqueue(encoded.subarray(3));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponseText(response, "fixture", encoded.length)).resolves.toBe(
      "a😀b",
    );
  });

  it("keeps timeout rejection ahead of cancel-unblocked stream reads", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    await expect(
      readBoundedResponseText(response, "probe", 1024, {
        timeoutPromise: Promise.reject(new Error("timeout")),
      }),
    ).rejects.toThrow("timeout");
    expect(canceled).toBe(true);
  });

  it("preserves opt-in ETOOBIG errors for E2E callers", async () => {
    await expect(
      readBoundedResponseText(new Response(new Uint8Array(17)), "probe", 16, {
        createTooLargeError: createBoundedResponseTooLargeError,
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "probe response body exceeded 16 bytes",
    });
  });

  it.each([
    { label: "equivalent", values: ["17", "017"], readsBody: false },
    { label: "conflicting", values: ["17", "12"], readsBody: true },
    { label: "malformed", values: ["17", "1e3"], readsBody: true },
    { label: "unsafe decimal", values: ["9007199254740993"], readsBody: false },
  ])("handles $label content-length values", async ({ values, readsBody }) => {
    const headers = new Headers(values.map((value) => ["content-length", value]));
    const { response, state } = responseProbe(headers, readsBody);

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toThrow(
      "probe response body exceeded 16 bytes",
    );
    expect(state).toEqual({ readStarted: readsBody, canceled: true });
  });
});
