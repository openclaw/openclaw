/**
 * ClawForge Orchestrator-Worker 类型定义
 */

/**
 * 任务状态
 */
export type TaskStatus = 
  | 'pending'
  | 'analyzing'
  | 'splitting'
  | 'executing'
  | 'merging'
  | 'completed'
  | 'failed';

/**
 * 子任务状态
 */
export type SubtaskStatus =
  | 'pending'
  | 'assigned'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'retrying';

/**
 * 任务定义
 */
export interface Task {
  id: string;
  type: 'complex' | 'simple';
  description: string;
  input: any;
  subtasks?: Subtask[];
  status: TaskStatus;
  progress: number;  // 0-100
  result?: any;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // 元数据
  orgId?: string;
  userId?: string;
  priority?: number;
}

/**
 * 子任务定义
 */
export interface Subtask {
  id: string;
  parentId: string;
  description: string;
  input: any;
  assignedTo?: string;  // Worker ID
  status: SubtaskStatus;
  progress: number;  // 0-100
  result?: any;
  retryCount: number;
  error?: string;
  
  // 依赖关系
  dependencies?: string[];  // 依赖的子任务 ID
  
  // 权重（用于进度计算）
  weight?: number;
  
  // 预计耗时（秒）
  estimatedDuration?: number;
}

/**
 * Worker 信息
 */
export interface WorkerInfo {
  id: string;
  status: 'idle' | 'busy' | 'offline';
  currentTaskId?: string;
  resourceUsage: {
    cpu: number;      // 0-100
    memory: number;   // 0-100
    disk: number;     // 0-100
  };
  lastHeartbeat: number;
  capabilities?: string[];
}

/**
 * Worker 心跳
 */
export interface Heartbeat {
  workerId: string;
  status: 'idle' | 'busy' | 'offline';
  currentTaskId?: string;
  resourceUsage: {
    cpu: number;
    memory: number;
    disk: number;
  };
  timestamp: number;
}

/**
 * Worker 命令（主节点 → Worker）
 */
export interface WorkerCommand {
  type: 'ASSIGN_TASK' | 'CANCEL_TASK' | 'GET_STATUS' | 'SHUTDOWN';
  taskId: string;
  payload?: any;
}

/**
 * Worker 响应（Worker → 主节点）
 */
export interface WorkerResponse {
  type: 'TASK_ACCEPTED' | 'TASK_PROGRESS' | 'TASK_COMPLETED' | 'TASK_FAILED';
  taskId: string;
  workerId: string;
  progress?: number;
  result?: any;
  error?: string;
  timestamp: number;
}

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  maxWorkers: number;
  taskTimeout: number;
  workerTimeout: number;
  retryAttempts: number;
  enableLoadBalancing: boolean;
  enableProgressTracking: boolean;
}

/**
 * Worker 配置
 */
export interface WorkerConfig {
  orchestratorUrl: string;
  heartbeatInterval: number;
  maxConcurrentTasks: number;
  resourceLimits: {
    maxMemory: string;
    maxCpu: string;
    maxDisk: string;
  };
}
