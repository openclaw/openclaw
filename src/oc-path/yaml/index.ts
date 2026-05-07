/**
 * `@openclaw/oc-path/yaml` — YAML kind public surface (subpath).
 *
 * Most consumers should use the universal `setOcPath` /
 * `resolveOcPath` from `@openclaw/oc-path` and let the substrate
 * dispatch via `ast.kind`. These per-kind functions exist for advanced
 * consumers and internal substrate dispatch.
 *
 * @module @openclaw/oc-path/yaml
 */

export type { YamlAst } from './ast.js';
export type { YamlParseResult } from './parse.js';
export { parseYaml } from './parse.js';
export type { YamlEmitOptions } from './emit.js';
export { emitYaml } from './emit.js';
export type { YamlOcPathMatch } from './resolve.js';
export { resolveYamlOcPath } from './resolve.js';
export type { YamlEditResult } from './edit.js';
export { setYamlOcPath, insertYamlOcPath } from './edit.js';
