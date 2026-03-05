/**
 * Legacy Web 服务器（已弃用）
 * 默认入口已切换到 apps/opengen-console（Next.js App Router）。
 * 该文件仅用于兼容旧的直连 API 调试流程。
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLLMClientFromEnv, createOrchestrator } from './index.js';
import type { UserRequest } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// 创建 orchestrator
const llmClient = createLLMClientFromEnv();
const orchestrator = createOrchestrator(llmClient, {
  stages: {
    pm: true,
    architect: false,
    coding: false,
    review: false,
    test: false,
    deploy: false,
  },
});

// API 路由
app.post('/api/generate', async (req, res) => {
  try {
    const { description, type, tech_stack } = req.body;

    if (!description || !type) {
      return res.status(400).json({
        error: 'Missing required fields: description, type',
      });
    }

    const request: UserRequest = {
      description,
      type,
      constraints: tech_stack ? { tech_stack } : undefined,
      user_id: 'web_user',
      request_id: `req_${Date.now()}`,
    };

    const task = orchestrator.createTask(request);
    const result = await orchestrator.executeTask(task.task_id);

    res.json(result);
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 启动服务器
app.listen(PORT, () => {
  console.warn("[DEPRECATED] src/codegen/server.ts is a legacy entrypoint.");
  console.warn("[DEPRECATED] Use `pnpm opengen:dev` to start the Next.js console.");
  console.log(`📡 Legacy API endpoint: http://localhost:${PORT}/api/generate`);
});
