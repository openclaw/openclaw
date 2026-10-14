export type UpdateDatabaseGenerations = Record<string, string | null>;
export type UpdateDatabaseWriteReceipt = {
  unchanged: boolean;
  fromGenerations?: UpdateDatabaseGenerations;
  generations: UpdateDatabaseGenerations;
};
