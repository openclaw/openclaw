import { createDecipheriv, createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { type Duplex, duplexPair } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  preauthenticateRfb,
  type RfbPreauthDescriptor,
  type RfbPreauthPeer,
} from "./rfb-preauth.js";

const DH = { generator: 5n, modulus: 7919n, privateKey: 7n };
const VERSION_3_8 = Buffer.from("RFB 003.008\n", "ascii");
const VNC: RfbPreauthDescriptor = {
  auth: "vnc-password",
  credentials: { password: "password" },
};
const ARD: RfbPreauthDescriptor = {
  auth: "ard-account",
  credentials: { username: "operator", password: "password" },
};

class ScriptedPeer extends EventEmitter implements RfbPreauthPeer {
  private buffered = Buffer.alloc(0);
  private failure: Error | undefined;

  constructor(readonly stream: Duplex) {
    super();
    stream.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.emit("available");
    });
    stream.once("error", (error) => {
      this.failure = error;
      this.emit("available");
    });
    stream.once("close", () => {
      this.failure = new Error("scripted peer closed");
      this.emit("available");
    });
  }

  async readExactly(length: number, signal?: AbortSignal): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (this.failure) {
        throw this.failure;
      }
      try {
        await once(this, "available", { signal });
      } catch {
        throw signal?.reason instanceof Error
          ? signal.reason
          : new Error("scripted RFB negotiation aborted");
      }
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  async write(buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }
}

function bigIntBuffer(value: bigint, length: number): Buffer {
  return Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex");
}

async function completeSyntheticBrowserHandshake(browser: ScriptedPeer, ready?: () => void) {
  expect(await browser.readExactly(12)).toEqual(VERSION_3_8);
  await browser.write(VERSION_3_8);
  expect(await browser.readExactly(2)).toEqual(Buffer.from([1, 1]));
  await browser.write(Buffer.from([1]));
  ready?.();
  expect(await browser.readExactly(4)).toEqual(Buffer.alloc(4));
}

async function offerSecurity(server: ScriptedPeer, types: number[], banner = VERSION_3_8) {
  await server.write(banner);
  expect(await server.readExactly(12)).toEqual(VERSION_3_8);
  await server.write(Buffer.from([types.length, ...types]));
  expect(await server.readExactly(1)).toEqual(Buffer.from([types[0]!]));
}

function ardHeader(keyLength: number) {
  return Buffer.from([0, 5, keyLength >> 8, keyLength & 255]);
}

async function runPreauth(params: {
  preauth?: RfbPreauthDescriptor;
  serverScript: (server: ScriptedPeer) => Promise<void>;
  browserScript?: (browser: ScriptedPeer) => Promise<void>;
  assertCurrent?: () => void;
}): Promise<void> {
  const [gatewayServer, fakeServerStream] = duplexPair();
  const [gatewayBrowserStream, fakeBrowserStream] = duplexPair();
  try {
    await Promise.all([
      preauthenticateRfb({
        server: gatewayServer,
        browser: new ScriptedPeer(gatewayBrowserStream),
        preauth: params.preauth ?? VNC,
        assertCurrent: params.assertCurrent,
      }),
      params.serverScript(new ScriptedPeer(fakeServerStream)),
      (params.browserScript ?? completeSyntheticBrowserHandshake)(
        new ScriptedPeer(fakeBrowserStream),
      ),
    ]);
  } finally {
    for (const stream of [
      gatewayServer,
      fakeServerStream,
      gatewayBrowserStream,
      fakeBrowserStream,
    ]) {
      stream.destroy();
    }
  }
}

async function writeArdOffer(server: ScriptedPeer, keyLength: number): Promise<void> {
  await offerSecurity(server, [30, 33, 36, 35], Buffer.from("RFB 003.889\n", "ascii"));
  const serverPublic = DH.generator ** DH.privateKey % DH.modulus;
  await server.write(
    Buffer.concat([
      ardHeader(keyLength),
      bigIntBuffer(DH.modulus, keyLength),
      bigIntBuffer(serverPublic, keyLength),
    ]),
  );
}

function rejectArd(serverScript: (server: ScriptedPeer) => Promise<void>, message: string) {
  return expect(
    runPreauth({ preauth: ARD, browserScript: async () => {}, serverScript }),
  ).rejects.toThrow(message);
}

describe("RFB server-side pre-authentication", () => {
  it("refuses credential response when ingress authority changes during the challenge read", async () => {
    let current = true;
    const responses: Buffer[] = [];
    await expect(
      runPreauth({
        preauth: { auth: "vnc-password", credentials: { password: "test-password" } },
        assertCurrent() {
          if (!current) {
            throw new Error("ingress authority revoked");
          }
        },
        serverScript: async (server) => {
          await offerSecurity(server, [2]);
          server.stream.on("data", (bytes: Buffer) => responses.push(bytes));
          current = false;
          await server.write(Buffer.from("0123456789abcdef"));
          await server.write(Buffer.alloc(4));
        },
      }),
    ).rejects.toThrow("ingress authority revoked");
    expect(responses).toEqual([]);
  });

  it("negotiates with the browser while upstream authentication is pending, withholding success", async () => {
    const browserReady = createDeferred();
    const events: string[] = [];
    await runPreauth({
      serverScript: async (server) => {
        await offerSecurity(server, [2]);
        await server.write(Buffer.from("0123456789abcdef"));
        await server.readExactly(16);
        await browserReady.promise;
        await setImmediate();
        expect(events).toEqual([]);
        events.push("upstream-authenticated");
        await server.write(Buffer.alloc(4));
      },
      browserScript: async (browser) => {
        await completeSyntheticBrowserHandshake(browser, browserReady.resolve);
        events.push("browser-authenticated");
      },
    });
    expect(events).toEqual(["upstream-authenticated", "browser-authenticated"]);
  });

  it("rejects a bad browser handshake without waiting for an upstream banner", async () => {
    await expect(
      runPreauth({
        serverScript: async (server) => {
          await server.readExactly(12);
        },
        browserScript: async (browser) => {
          expect(await browser.readExactly(12)).toEqual(VERSION_3_8);
          await browser.write(Buffer.from("RFB 003.003\n"));
        },
      }),
    ).rejects.toThrow("RFB browser did not accept protocol version 3.8");
  });

  it("negotiates ARD framing and encrypted credentials", async () => {
    const keyLength = 16;
    const username = "screen-user";
    const password = "screen-password";
    await runPreauth({
      preauth: { auth: "ard-account", credentials: { username, password } },
      serverScript: async (server) => {
        await writeArdOffer(server, keyLength);
        const response = await server.readExactly(128 + keyLength);
        expect(response).toHaveLength(128 + keyLength);

        const clientPublic = BigInt(`0x${response.subarray(128).toString("hex")}`);
        const shared = clientPublic ** DH.privateKey % DH.modulus;
        const key = createHash("md5").update(bigIntBuffer(shared, keyLength)).digest();
        const decipher = createDecipheriv("aes-128-ecb", key, null);
        decipher.setAutoPadding(false);
        const plaintext = Buffer.concat([
          decipher.update(response.subarray(0, 128)),
          decipher.final(),
        ]);
        expect(plaintext.subarray(0, username.length + 1)).toEqual(Buffer.from(username + "\0"));
        expect(plaintext.subarray(64, 65 + password.length)).toEqual(Buffer.from(password + "\0"));
        await server.write(Buffer.alloc(4));
      },
    });
  });

  it.each([
    [0, false, "invalid ARD key length 0"],
    [1025, false, "invalid ARD key length 1025"],
    [8, true, "invalid ARD Diffie-Hellman parameters"],
  ] as const)("rejects malformed ARD parameters: %s", async (length, zero, message) => {
    await rejectArd(async (server) => {
      await offerSecurity(server, [30]);
      await server.write(
        Buffer.concat([ardHeader(length), zero ? Buffer.alloc(16) : Buffer.alloc(0)]),
      );
    }, message);
  });

  it("surfaces the ARD server SecurityResult reason", async () => {
    await rejectArd(async (server) => {
      await writeArdOffer(server, 16);
      await server.readExactly(144);
      const reason = Buffer.from("account rejected", "utf8");
      const status = Buffer.alloc(8);
      status.writeUInt32BE(1, 0);
      status.writeUInt32BE(reason.length, 4);
      await server.write(Buffer.concat([status, reason]));
    }, "RFB authentication failed: account rejected");
  });

  it.each([
    ["RFB 003.003\n", "RFB 003.003\n", true],
    ["RFB 003.007\n", "RFB 003.007\n", false],
  ])("matches the VncAuth DES vector with server version %j", async (banner, reply, legacy) => {
    const challenge = Buffer.from("0123456789abcdef", "ascii");
    await runPreauth({
      serverScript: async (server) => {
        await server.write(Buffer.from(banner));
        expect(await server.readExactly(12)).toEqual(Buffer.from(reply));
        await server.write(legacy ? Buffer.from([0, 0, 0, 2]) : Buffer.from([1, 2]));
        if (!legacy) {
          expect(await server.readExactly(1)).toEqual(Buffer.from([2]));
        }
        await server.write(challenge);
        expect((await server.readExactly(16)).toString("hex")).toBe(
          "5645abeb5f1e6475e8feb11beb66ea19",
        );
        await server.write(Buffer.alloc(4));
      },
    });
  });
});
