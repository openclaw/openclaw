import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

// ─── Search ───────────────────────────────────────────────────────────────────

export const ClawdHubSearchParamsSchema = Type.Object(
  {
    query: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const ClawdHubSearchResultSchema = Type.Object(
  {
    slug: NonEmptyString,
    name: NonEmptyString,
    description: Type.String(),
    emoji: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    version: NonEmptyString,
    downloads: Type.Integer({ minimum: 0 }),
    stars: Type.Integer({ minimum: 0 }),
    updatedAt: Type.String(),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ClawdHubSearchResponseSchema = Type.Object(
  {
    results: Type.Array(ClawdHubSearchResultSchema),
    total: Type.Integer({ minimum: 0 }),
    query: Type.String(),
  },
  { additionalProperties: false },
);

// ─── Details ──────────────────────────────────────────────────────────────────

export const ClawdHubDetailsParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ClawdHubVersionSchema = Type.Object(
  {
    version: NonEmptyString,
    changelog: Type.Optional(Type.String()),
    publishedAt: Type.String(),
    tags: Type.Array(Type.String()),
    downloads: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ClawdHubDetailsResponseSchema = Type.Object(
  {
    slug: NonEmptyString,
    name: NonEmptyString,
    description: Type.String(),
    emoji: Type.Optional(Type.String()),
    readme: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    homepage: Type.Optional(Type.String()),
    repository: Type.Optional(Type.String()),
    license: Type.Optional(Type.String()),
    currentVersion: NonEmptyString,
    versions: Type.Array(ClawdHubVersionSchema),
    downloads: Type.Integer({ minimum: 0 }),
    stars: Type.Integer({ minimum: 0 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

// ─── Install ──────────────────────────────────────────────────────────────────

export const ClawdHubInstallParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ClawdHubInstallResponseSchema = Type.Object(
  {
    ok: Type.Boolean(),
    slug: NonEmptyString,
    version: NonEmptyString,
    path: Type.String(),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// ─── Installed ────────────────────────────────────────────────────────────────

export const ClawdHubInstalledParamsSchema = Type.Object({}, { additionalProperties: false });

export const ClawdHubInstalledSkillSchema = Type.Object(
  {
    slug: NonEmptyString,
    version: NonEmptyString,
    installedAt: Type.String(),
    path: Type.String(),
    name: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ClawdHubInstalledResponseSchema = Type.Object(
  {
    skills: Type.Array(ClawdHubInstalledSkillSchema),
  },
  { additionalProperties: false },
);

// ─── Check Updates ────────────────────────────────────────────────────────────

export const ClawdHubCheckUpdatesParamsSchema = Type.Object({}, { additionalProperties: false });

export const ClawdHubUpdateCheckSchema = Type.Object(
  {
    slug: NonEmptyString,
    currentVersion: NonEmptyString,
    latestVersion: NonEmptyString,
    hasUpdate: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ClawdHubCheckUpdatesResponseSchema = Type.Object(
  {
    updates: Type.Array(ClawdHubUpdateCheckSchema),
  },
  { additionalProperties: false },
);

// ─── Type Exports ─────────────────────────────────────────────────────────────

export type ClawdHubSearchParams = {
  query: string;
  limit?: number;
};

export type ClawdHubSearchResult = {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  author?: string;
  version: string;
  downloads: number;
  stars: number;
  updatedAt: string;
  tags: string[];
};

export type ClawdHubSearchResponse = {
  results: ClawdHubSearchResult[];
  total: number;
  query: string;
};

export type ClawdHubDetailsParams = {
  slug: string;
};

export type ClawdHubVersion = {
  version: string;
  changelog?: string;
  publishedAt: string;
  tags: string[];
  downloads: number;
};

export type ClawdHubDetailsResponse = {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  readme?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  currentVersion: string;
  versions: ClawdHubVersion[];
  downloads: number;
  stars: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type ClawdHubInstallParams = {
  slug: string;
  version?: string;
  force?: boolean;
};

export type ClawdHubInstallResponse = {
  ok: boolean;
  slug: string;
  version: string;
  path: string;
  message?: string;
};

export type ClawdHubInstalledParams = Record<string, never>;

export type ClawdHubInstalledSkill = {
  slug: string;
  version: string;
  installedAt: string;
  path: string;
  name?: string;
  description?: string;
  emoji?: string;
};

export type ClawdHubInstalledResponse = {
  skills: ClawdHubInstalledSkill[];
};

export type ClawdHubCheckUpdatesParams = Record<string, never>;

export type ClawdHubUpdateCheck = {
  slug: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
};

export type ClawdHubCheckUpdatesResponse = {
  updates: ClawdHubUpdateCheck[];
};
