// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  currentStoredConfigSnapshot,
  invalidateConfigConnection,
} from "../config/config-state-model.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { gatewaySnapshot } from "../config/stored-secret-source.test-support.ts";
import { skillApiKeyReplaceable } from "./api-key-source.ts";
import { createSkillsState } from "./index.test-support.ts";
import { saveSkillApiKey } from "./index.ts";

describe("skill API key source admission", () => {
  it.each([
    { name: "literal", config: { apiKey: "plain-not-real" }, allowed: true },
    { name: "absent", config: {}, allowed: true },
    {
      name: "SecretRef",
      config: { apiKey: { source: "env", provider: "default", id: "SET_TOKEN" } },
      allowed: false,
    },
    { name: "environment", config: { apiKey: "${SET_TOKEN}" }, allowed: false },
    { name: "invalid", config: {}, allowed: false },
    { name: "denied", config: {}, allowed: false },
    { name: "stale connection", config: { apiKey: "plain-not-real" }, allowed: false },
  ])(
    "admits only proven writable key sources through the real config owner: $name",
    async ({ name, config, allowed }) => {
      const { state, request } = createSkillsState();
      request.mockImplementation(async (method) => {
        if (method === "config.get") {
          if (name === "denied") {
            throw new Error("config.get denied");
          }
          const snapshot = gatewaySnapshot({ skills: { entries: { github: config } } });
          return name === "invalid" ? { ...snapshot, valid: false } : snapshot;
        }
        return { workspaceDir: "/fixture", managedSkillsDir: "/fixture", skills: [] };
      });
      const client = expectDefined(state.client, "skill client");
      const owner = createRuntimeConfigCapability({
        snapshot: { client, phase: "connected", sessionKey: "main" },
        subscribe: () => () => undefined,
      });
      state.runtimeConfig = owner;
      try {
        await owner.ensureLoaded();
        if (name === "stale connection") {
          invalidateConfigConnection(owner.state);
        }
        state.skillEdits.github = "  replacement-not-real  ";
        await saveSkillApiKey(state, "github", () =>
          skillApiKeyReplaceable(currentStoredConfigSnapshot(owner.state), "github"),
        );
        expect(request.mock.calls.filter(([method]) => method === "skills.update")).toEqual(
          allowed ? [["skills.update", { skillKey: "github", apiKey: "replacement-not-real" }]] : [],
        );
        expect(state.skillMessages.github?.kind).toBe(allowed ? "success" : "error");
        if (name === "denied") {
          expect(owner.state.lastError).toContain("config.get denied");
        }
      } finally {
        owner.dispose();
      }
    },
  );

  it.each(["reference", "access", "connection"])(
    "rechecks key provenance, access, and connection after the pending Settings flush: %s",
    async (change) => {
      const { state, request } = createSkillsState();
      const saved = createDeferred<unknown>();
      let canDispatch = true;
      const reference = { source: "env", provider: "default", id: "SET_TOKEN" };
      const initial = { skills: { entries: { github: { apiKey: "plain-not-real" } } } };
      request.mockImplementation(async (method) => {
        if (method === "config.get") {
          return gatewaySnapshot(initial);
        }
        if (method === "config.set") {
          return saved.promise;
        }
        return {};
      });
      const client = expectDefined(state.client, "skill client");
      const owner = createRuntimeConfigCapability({
        snapshot: {
          client,
          phase: "connected",
          sessionKey: "main",
          hello: gatewayHelloForMethods(["config.set"]),
        },
        subscribe: () => () => undefined,
      });
      state.runtimeConfig = owner;
      try {
        await owner.ensureLoaded();
        if (change === "reference") {
          owner.patchForm(["skills", "entries", "github", "apiKey"], reference);
        } else {
          owner.patchForm(["count"], 2);
        }
        state.skillEdits.github = "replacement-not-real";
        const saving = saveSkillApiKey(
          state,
          "github",
          () => skillApiKeyReplaceable(currentStoredConfigSnapshot(owner.state), "github"),
          () => canDispatch,
        );
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("config.set", expect.anything()),
        );
        if (change === "access") {
          canDispatch = false;
        }
        if (change === "connection") {
          invalidateConfigConnection(owner.state);
        }
        saved.resolve({
          config:
            change === "reference"
              ? { skills: { entries: { github: { apiKey: reference } } } }
              : { ...gatewaySnapshot(initial).config, count: 2 },
          hash: "hash-2",
        });
        await saving;
        expect(request.mock.calls.filter(([method]) => method === "skills.update")).toEqual([]);
        expect(state.skillMessages.github?.kind).toBe("error");
        if (change !== "connection") {
          expect(state.skillMessages.github?.message).toContain("API key not saved");
          expect(state.skillMessages.github?.message).toContain("stored key changed");
        }
      } finally {
        owner.dispose();
      }
    },
  );
});
