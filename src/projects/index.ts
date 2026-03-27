// Schemas
export {
  ProjectFrontmatterSchema,
  TaskFrontmatterSchema,
  QueueFrontmatterSchema,
} from "./schemas.js";

// Types
export type {
  ProjectFrontmatter,
  TaskFrontmatter,
  QueueFrontmatter,
  ParseResult,
  ParseError,
} from "./types.js";

// Errors
export { formatWarning } from "./errors.js";
export type { FrontmatterParseWarning } from "./errors.js";

// Parsers (frontmatter.ts will exist once Plan 01-02 completes)
export {
  parseProjectFrontmatter,
  parseTaskFrontmatter,
  parseQueueFrontmatter,
} from "./frontmatter.js";

// Queue
export { parseQueue } from "./queue-parser.js";
export type { QueueEntry, ParsedQueue } from "./queue-parser.js";

// Scaffold
export { ProjectManager } from "./scaffold.js";
export type { CreateProjectOpts, CreateSubProjectOpts } from "./scaffold.js";
export { generateProjectMd, generateQueueMd } from "./templates.js";
