import { describe, expect, it } from "vitest";
import { customEndpointParams, prepareCustomEndpointPatch } from "./config-custom-endpoint.js";

const row = { id: "chat", edits: { name: "Lab chat" } };
const draft = {
  action: "create" as const,
  provider: "lab-inference",
  baseHash: "revision",
  baseUrl: "http://lab.lan:8000/v1",
  api: "openai-completions" as const,
  noAuth: true,
  models: [row],
};
type Source = Parameters<typeof prepareCustomEndpointPatch>[1];
const source: Source = {
  models: {
    providers: {
      [draft.provider]: {
        baseUrl: draft.baseUrl,
        api: draft.api,
        models: [{ id: "chat", name: "Lab chat" }],
      },
    },
  },
};

describe("independent custom endpoint config intent", () => {
  it("preserves branding through endpoint edits and carries explicit clears without touching credential identity", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const branded: Source = {
      models: {
        providers: {
          [draft.provider]: {
            ...source.models?.providers?.[draft.provider],
            name: "Lab inference",
            logo,
            apiKey: { source: "env", provider: "default", id: "LAB_KEY" },
            request: { allowPrivateNetwork: true },
          },
        },
      },
    };
    const params = {
      ...draft,
      action: "edit" as const,
      models: [{ id: "chat", existingId: "chat", edits: {} }],
    };
    const provider = (value: ReturnType<typeof prepareCustomEndpointPatch>) =>
      JSON.parse(value.raw).models.providers[draft.provider];
    expect(provider(prepareCustomEndpointPatch(params, branded))).toMatchObject({
      name: "Lab inference",
      logo,
      apiKey: { source: "env", provider: "default", id: "LAB_KEY" },
      request: { allowPrivateNetwork: true },
    });
    expect(
      provider(prepareCustomEndpointPatch({ ...params, name: "New name", logo: null }, branded)),
    ).toMatchObject({ name: "New name", logo: null });
    expect(customEndpointParams.safeParse({ ...params, name: null, logo: null }).success).toBe(
      true,
    );
    for (const unsafe of [
      "https://images.example/logo.png",
      "javascript:alert(1)",
      "<svg onload=alert(1)>",
    ]) {
      expect(customEndpointParams.safeParse({ ...params, logo: unsafe }).success).toBe(false);
    }
  });
  it("creates distinct models without inventing token, capability, or cost metadata", () => {
    const patch = JSON.parse(
      prepareCustomEndpointPatch(
        { ...draft, models: [row, { id: "vision", edits: { name: "Vision", imageInput: true } }] },
        {},
      ).raw,
    );
    expect(patch).toEqual({
      models: {
        providers: {
          [draft.provider]: {
            baseUrl: draft.baseUrl,
            api: draft.api,
            auth: "none",
            models: [
              { id: "chat", name: "Lab chat" },
              { id: "vision", name: "Vision", input: ["text", "image"] },
            ],
          },
        },
      },
    });
    expect(() => prepareCustomEndpointPatch(draft, source)).toThrow("already exists");
    expect(() => prepareCustomEndpointPatch({ ...draft, provider: "openai" }, {})).toThrow(
      "integration",
    );
    expect(() => prepareCustomEndpointPatch({ ...draft, provider: " Lab Inference " }, {})).toThrow(
      "lowercase",
    );
  });
  it("preserves advanced metadata and omitted fields, with explicit modality edits retaining audio/video", () => {
    const cfg: Source = {
      models: {
        providers: {
          [draft.provider]: {
            baseUrl: draft.baseUrl,
            api: draft.api,
            apiKey: { source: "env", provider: "default", id: "LAB_KEY" },
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "chat",
                name: "Lab chat",
                input: ["audio", "video"],
                api: "openai-responses",
                baseUrl: "https://override.example/v1",
                compat: { supportsStore: false },
                cost: { input: 2 },
              },
            ],
          },
        },
      },
    };
    const patch = prepareCustomEndpointPatch(
      {
        ...draft,
        action: "edit",
        noAuth: false,
        models: [
          { id: "renamed", existingId: "chat", edits: { name: "Renamed", imageInput: true } },
        ],
      },
      cfg,
    );
    expect(JSON.parse(patch.raw).models.providers[draft.provider]).toEqual({
      ...cfg.models?.providers?.[draft.provider],
      models: [
        {
          ...cfg.models?.providers?.[draft.provider]?.models?.[0],
          id: "renamed",
          name: "Renamed",
          input: ["audio", "video", "image"],
        },
      ],
    });
    const duplicateInput: Source = {
      models: {
        providers: {
          [draft.provider]: {
            baseUrl: draft.baseUrl,
            api: draft.api,
            models: [{ id: "chat", name: "Chat", input: ["audio", "image", "image"] }],
          },
        },
      },
    };
    const removedImage = prepareCustomEndpointPatch(
      {
        ...draft,
        action: "edit",
        models: [{ id: "chat", existingId: "chat", edits: { imageInput: false } }],
      },
      duplicateInput,
    );
    expect(JSON.parse(removedImage.raw).models.providers[draft.provider].models).toEqual([
      { id: "chat", name: "Chat", input: ["audio"] },
    ]);
    expect(() =>
      prepareCustomEndpointPatch(
        { ...draft, action: "edit", models: [{ id: "chat", existingId: "chat", edits: {} }] },
        cfg,
      ),
    ).toThrow("including model overrides");
    expect(() => prepareCustomEndpointPatch({ ...draft, api: "openai-responses" }, {})).toThrow(
      "Chat Completions",
    );
  });
  it("protects configured references and existing model identity during removal or rename", () => {
    const cfg: Source = {
      ...source,
      agents: { defaults: { model: draft.provider + "/chat@lab:manual" } },
    };
    expect(() =>
      prepareCustomEndpointPatch(
        { action: "delete", provider: draft.provider, baseHash: "revision" },
        cfg,
      ),
    ).toThrow("agents.defaults.model");
    expect(() =>
      prepareCustomEndpointPatch(
        { ...draft, action: "edit", models: [{ id: "other", existingId: "chat", edits: {} }] },
        cfg,
      ),
    ).toThrow("agents.defaults.model");
    expect(() => prepareCustomEndpointPatch({ ...draft, action: "edit" }, source)).toThrow(
      "already belongs",
    );
    expect(() =>
      prepareCustomEndpointPatch(
        { ...draft, action: "edit", models: [{ id: "other", existingId: "missing", edits: {} }] },
        source,
      ),
    ).toThrow("no longer exists");
    expect(
      JSON.parse(
        prepareCustomEndpointPatch(
          { action: "delete", provider: draft.provider, baseHash: "revision" },
          source,
        ).raw,
      ),
    ).toEqual({ models: { providers: { [draft.provider]: null } } });
  });
  it("validates adapters and only explicit field edits", () => {
    expect(customEndpointParams.safeParse(draft).success).toBe(true);
    for (const change of [
      { baseUrl: "not a URL" },
      { api: "google-generative-ai" },
      { baseUrl: "https://secret:password@lab.example/v1" },
      { models: [] },
      { models: [{ id: "chat", edits: { maxTokens: -1 } }] },
      { models: [{ ...row, contextWindow: 128000 }] },
    ]) {
      expect(customEndpointParams.safeParse({ ...draft, ...change }).success).toBe(false);
    }
  });
});
