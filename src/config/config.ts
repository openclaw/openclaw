/**
 * 配置模块导出入口
 * 本文件作为配置模块的统一导出点，聚合了配置读取、写入、验证等核心功能的导出
 */

// ============================================================
// 配置 IO 相关导出 - 来自 io.ts
// ============================================================

/**
 * 清除配置缓存
 */
export {
  clearConfigCache,
  /**
   * 配置运行时刷新错误
   */
  ConfigRuntimeRefreshError,
  /**
   * 清除运行时配置快照
   */
  clearRuntimeConfigSnapshot,
  /**
   * 注册配置写入监听器
   */
  registerConfigWriteListener,
  /**
   * 创建配置 IO 实例
   */
  createConfigIO,
  /**
   * 获取运行时配置
   */
  getRuntimeConfig,
  /**
   * 获取运行时配置快照元数据
   */
  getRuntimeConfigSnapshotMetadata,
  /**
   * 获取运行时配置快照
   */
  getRuntimeConfigSnapshot,
  /**
   * 获取运行时配置源快照
   */
  getRuntimeConfigSourceSnapshot,
  /**
   * 将项目配置应用到运行时源快照
   */
  projectConfigOntoRuntimeSourceSnapshot,
  /**
   * 加载配置
   */
  loadConfig,
  /**
   * 尽力读取配置（容错模式）
   */
  readBestEffortConfig,
  /**
   * 尽力读取源配置
   */
  readSourceConfigBestEffort,
  /**
   * 解析 JSON5 格式配置
   */
  parseConfigJson5,
  /**
   * 将配置快照提升为最后已知良好状态
   */
  promoteConfigSnapshotToLastKnownGood,
  /**
   * 读取配置文件快照
   */
  readConfigFileSnapshot,
  /**
   * 读取带插件元数据的配置文件快照
   */
  readConfigFileSnapshotWithPluginMetadata,
  /**
   * 读取用于写入的配置文件快照
   */
  readConfigFileSnapshotForWrite,
  /**
   * 读取源配置快照
   */
  readSourceConfigSnapshot,
  /**
   * 读取用于写入的源配置快照
   */
  readSourceConfigSnapshotForWrite,
  /**
   * 从最后已知良好配置恢复
   */
  recoverConfigFromLastKnownGood,
  /**
   * 从 JSON 根后缀恢复配置
   */
  recoverConfigFromJsonRootSuffix,
  /**
   * 重置配置运行时状态
   */
  resetConfigRuntimeState,
  /**
   * 解析配置快照哈希
   */
  resolveConfigSnapshotHash,
  /**
   * 解析运行时配置缓存键
   */
  resolveRuntimeConfigCacheKey,
  /**
   * 选择适用的运行时配置
   */
  selectApplicableRuntimeConfig,
  /**
   * 设置运行时配置快照刷新处理器
   */
  setRuntimeConfigSnapshotRefreshHandler,
  /**
   * 设置运行时配置快照
   */
  setRuntimeConfigSnapshot,
  /**
   * 写入配置文件
   */
  writeConfigFile,
} from "./io.js";

// ============================================================
// 运行时快照相关导出 - 来自 runtime-snapshot.js
// ============================================================

/**
 * 对运行时配置值进行哈希
 */
export {
  hashRuntimeConfigValue,
  /**
   * 解析配置写入后的后续操作
   */
  resolveConfigWriteAfterWrite,
  /**
   * 解析配置写入的跟进操作
   */
  resolveConfigWriteFollowUp,
} from "./runtime-snapshot.js";

/**
 * 配置写入后续操作类型
 */
export type {
  ConfigWriteAfterWrite,
  ConfigWriteFollowUp,
  /**
   * 运行时配置快照元数据
   */
  RuntimeConfigSnapshotMetadata,
} from "./runtime-snapshot.js";

/**
 * 配置写入通知类型
 */
export type { ConfigWriteNotification } from "./io.js";

// ============================================================
// 配置变更相关导出 - 来自 mutate.js
// ============================================================

/**
 * 配置变更冲突错误
 */
export {
  ConfigMutationConflictError,
  /**
   * 变更配置文件
   */
  mutateConfigFile,
  /**
   * 替换配置文件
   */
  replaceConfigFile,
} from "./mutate.js";

// ============================================================
// 路径相关导出 - 来自 paths.js
// ============================================================
export * from "./paths.js";

// ============================================================
// 恢复策略导出 - 来自 recovery-policy.js
// ============================================================
export * from "./recovery-policy.js";

// ============================================================
// 运行时覆盖导出 - 来自 runtime-overrides.js
// ============================================================
export * from "./runtime-overrides.js";

// ============================================================
// 类型导出 - 来自 types.js
// ============================================================
export * from "./types.js";

// ============================================================
// 配置验证导出 - 来自 validation.js
// ============================================================

/**
 * 验证配置对象
 */
export {
  validateConfigObject,
  /**
   * 原始验证配置对象
   */
  validateConfigObjectRaw,
  /**
   * 使用插件进行原始验证
   */
  validateConfigObjectRawWithPlugins,
  /**
   * 使用插件验证配置对象
   */
  validateConfigObjectWithPlugins,
} from "./validation.js";
