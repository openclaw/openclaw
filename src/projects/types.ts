import type { z } from "zod";
import type {
  ProjectFrontmatterSchema,
  QueueFrontmatterSchema,
  TaskFrontmatterSchema,
} from "./schemas.js";

export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatterSchema>;
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
export type QueueFrontmatter = z.infer<typeof QueueFrontmatterSchema>;

export type ParseError = {
  filePath: string;
  message: string;
  issues: Array<{ path: string; message: string; line?: number }>;
};

export type ParseResult<T> = { success: true; data: T } | { success: false; error: ParseError };
