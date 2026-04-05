import type { MullusiConfig } from "../../config/types.js";

export type DirectoryConfigParams = {
  cfg: MullusiConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};
