export type DatabaseEngineInput =
  | Readonly<{ connection: string; schemaPrefix: string }>
  | undefined;
export type DatabaseEngineId = "sqlite" | "postgres";
