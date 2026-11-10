import { describe, expect, it, vi } from "vitest";
import { createOpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import { linkedClaw, memoryStore, serviceFor, TEST_K_SRV } from "./openclaw-id.test-support.js";

// The K_srv getter each tunnel child (re)start reads, as the service passes it.
const runtime = vi.hoisted(() => ({
  boundEndpointKey: undefined as (() => string | undefined) | undefined,
}));
// mock-isolation: the native tunnel child stays out; the test reads what a restart would be told.
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: {
    settings: unknown;
    boundEndpointKey: () => string | undefined;
  }) => {
    runtime.boundEndpointKey = params.boundEndpointKey;
    return {
      settings: params.settings,
      supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
      pushMembership: vi.fn(),
      stop: async () => {},
    };
  },
}));

describe("tunnel child restarts for a linked claw", () => {
  it("stay on the bound K_srv after an uncertain write withdraws the authority", async () => {
    const claw = await linkedClaw();
    let uncertain = false;
    const authority = createOpenClawIdAuthority({
      read: async () => {
        if (uncertain) {
          throw new Error("read unavailable");
        }
        return claw.store.read();
      },
      write: async (next: StoredClaw) => {
        await claw.store.write(next);
        if (uncertain) {
          throw new Error("acknowledgement lost");
        }
      },
      profiles: claw.store.profiles,
    });
    const { service } = serviceFor(
      authority,
      { enabled: true, relayUrl: "https://relay.test/" },
      claw.stateDir,
    );
    try {
      await service.reconcileRuntimePolicy();
      expect(runtime.boundEndpointKey?.()).toBe(TEST_K_SRV);
      uncertain = true;
      await expect(authority.recordDiscovery({ mailbox_cursor: "x" })).rejects.toThrow("uncertain");
      expect(authority.current()).toBeUndefined();
      // Never the unlinked start, which would create or accept any endpoint key.
      expect(runtime.boundEndpointKey?.()).toBe(TEST_K_SRV);
    } finally {
      await service.stop();
    }
  });

  it.each(["initial link", "later write"])(
    "stay on K_srv when %s persistence is uncertain",
    async (phase) => {
      const store = memoryStore();
      let uncertain = false;
      const flaky = {
        read: async () => {
          if (uncertain) {
            throw new Error("read unavailable");
          }
          return store.read();
        },
        write: async (next: StoredClaw) => {
          await store.write(next);
          if (uncertain) {
            throw new Error("acknowledgement lost");
          }
        },
      };
      let service: ReturnType<typeof serviceFor>["service"] | undefined;
      let owner: ReturnType<typeof createOpenClawIdAuthority> | undefined;
      const linking = linkedClaw(flaky, async (authority, stateDir, input) => {
        owner = authority;
        service = serviceFor(
          authority,
          { enabled: true, relayUrl: "https://relay.test/" },
          stateDir,
        ).service;
        await service.reconcileRuntimePolicy();
        expect(runtime.boundEndpointKey?.()).toBeUndefined();
        uncertain = phase === "initial link";
        return await service.commitLink("local_operator", input);
      });
      try {
        if (phase === "initial link") {
          await expect(linking).rejects.toThrow("uncertain");
        } else {
          const claw = await linking;
          uncertain = true;
          await expect(claw.authority.recordDiscovery({ mailbox_cursor: "x" })).rejects.toThrow(
            "uncertain",
          );
        }
        expect((await store.read())?.binding?.body.k_srv).toBe(TEST_K_SRV);
        expect(owner?.current()).toBeUndefined();
        expect(runtime.boundEndpointKey?.()).toBe(TEST_K_SRV);
      } finally {
        await service?.stop();
      }
    },
  );
});
