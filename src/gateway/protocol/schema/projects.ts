import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const ProjectMemoryModeSchema = Type.Union([
  Type.Literal("project_only"),
  Type.Literal("shared"),
]);

export const ProjectsListParamsSchema = Type.Object(
  {
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ProjectsGetParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    includeSessions: Type.Optional(Type.Boolean()),
    includeContextPreview: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ProjectsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    memoryMode: Type.Optional(ProjectMemoryModeSchema),
    color: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProjectsUpdateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: Type.Optional(NullableStringSchema),
    description: Type.Optional(NullableStringSchema),
    instructions: Type.Optional(NullableStringSchema),
    memoryMode: Type.Optional(ProjectMemoryModeSchema),
    color: Type.Optional(NullableStringSchema),
    emoji: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false },
);

export const ProjectsDeleteParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsRestoreParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsResourcesListParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsResourcesAddParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProjectsResourcesUploadParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    name: Type.Optional(Type.String()),
    fileName: NonEmptyString,
    mediaType: Type.Optional(Type.String()),
    contentBase64: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsResourcesRemoveParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    resourceId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsResourcesReindexParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    resourceId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsSessionsListParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ProjectsSessionsAttachParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsSessionsDetachParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProjectsContextPreviewParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    query: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Integer({ minimum: 1000 })),
    maxResources: Type.Optional(Type.Integer({ minimum: 1 })),
    includeSessions: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
