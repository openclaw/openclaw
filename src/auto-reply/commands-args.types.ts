export type CommandArgValues = Record<string, string | number | boolean | bigint>;

export type CommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
