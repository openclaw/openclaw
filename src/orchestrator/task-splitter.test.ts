/**
 * Orchestrator-Worker 任务拆分器单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskSplitter, type Task, type Subtask } from './task-splitter.js';

describe('TaskSplitter', () => {
  let splitter: TaskSplitter;

  beforeEach(() => {
    splitter = new TaskSplitter();
  });

  describe('splitCodeReviewTask', () => {
    it('should split code review task by directories', async () => {
      const task: Task = {
        id: 'task_001',
        type: 'complex',
        description: '审查整个项目的代码质量',
        input: {
          projectPath: '/workspace/clawforge',
          directories: ['src/auth', 'src/storage', 'src/gateway', 'src/admin'],
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.length).toBeGreaterThan(0);
      expect(subtasks.every(st => st.parentId === 'task_001')).toBe(true);
      expect(subtasks.every(st => st.description.includes('审查'))).toBe(true);
    });

    it('should handle empty directory list', async () => {
      const task: Task = {
        id: 'task_002',
        type: 'complex',
        description: '审查代码',
        input: {
          projectPath: '/workspace/test',
          directories: [],
        },
      };

      const subtasks = await splitter.splitTask(task);
      expect(subtasks.length).toBe(0);
    });
  });

  describe('splitDataAnalysisTask', () => {
    it('should split data analysis task by chunks', async () => {
      const task: Task = {
        id: 'task_003',
        type: 'complex',
        description: '分析 100 万条销售数据',
        input: {
          totalRecords: 1000000,
          chunkSize: 250000,
          dataType: 'sales',
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.length).toBe(4); // 1000000 / 250000 = 4
      expect(subtasks[0].input).toEqual({
        startRecord: 0,
        endRecord: 250000,
        dataType: 'sales',
      });
    });

    it('should handle non-divisible chunk sizes', async () => {
      const task: Task = {
        id: 'task_004',
        type: 'complex',
        description: '分析数据',
        input: {
          totalRecords: 100,
          chunkSize: 30,
          dataType: 'test',
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.length).toBe(4); // ceil(100/30) = 4
      expect(subtasks[subtasks.length - 1].input).toEqual({
        startRecord: 90,
        endRecord: 100,
        dataType: 'test',
      });
    });
  });

  describe('splitDocumentGenerationTask', () => {
    it('should split document generation by API endpoints', async () => {
      const task: Task = {
        id: 'task_005',
        type: 'complex',
        description: '为所有 API 端点生成文档',
        input: {
          endpoints: [
            { path: '/api/users', method: 'GET' },
            { path: '/api/users', method: 'POST' },
            { path: '/api/products', method: 'GET' },
            { path: '/api/orders', method: 'POST' },
          ],
          batchSize: 2,
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.length).toBe(2); // 4 endpoints / 2 batch size = 2
      expect(subtasks[0].input.endpoints.length).toBe(2);
      expect(subtasks[1].input.endpoints.length).toBe(2);
    });
  });

  describe('calculateSubtaskWeight', () => {
    it('should calculate weight based on estimated duration', async () => {
      const task: Task = {
        id: 'task_006',
        type: 'complex',
        description: '混合任务',
        input: {
          items: [
            { type: 'heavy', duration: 100 },
            { type: 'light', duration: 10 },
            { type: 'medium', duration: 50 },
          ],
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.every(st => st.weight > 0)).toBe(true);
      
      // Heavier tasks should have higher weight
      const heavySubtask = subtasks.find(st => st.input.type === 'heavy');
      const lightSubtask = subtasks.find(st => st.input.type === 'light');
      
      expect(heavySubtask!.weight).toBeGreaterThan(lightSubtask!.weight);
    });
  });

  describe('identifyDependencies', () => {
    it('should identify no dependencies for independent tasks', async () => {
      const task: Task = {
        id: 'task_007',
        type: 'complex',
        description: '并行处理独立文件',
        input: {
          files: ['file1.txt', 'file2.txt', 'file3.txt'],
          independent: true,
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.every(st => st.dependencies.length === 0)).toBe(true);
    });

    it('should identify sequential dependencies', async () => {
      const task: Task = {
        id: 'task_008',
        type: 'complex',
        description: '顺序处理任务',
        input: {
          steps: ['extract', 'transform', 'load'],
          sequential: true,
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.length).toBe(3);
      expect(subtasks[0].dependencies).toEqual([]);
      expect(subtasks[1].dependencies).toEqual([subtasks[0].id]);
      expect(subtasks[2].dependencies).toEqual([subtasks[1].id]);
    });
  });

  describe('estimateDuration', () => {
    it('should estimate duration based on input size', async () => {
      const task: Task = {
        id: 'task_009',
        type: 'complex',
        description: '处理数据',
        input: {
          recordCount: 1000,
          estimatedTimePerRecord: 0.1, // seconds
        },
      };

      const subtasks = await splitter.splitTask(task);

      expect(subtasks.every(st => st.estimatedDuration > 0)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle task with no input', async () => {
      const task: Task = {
        id: 'task_010',
        type: 'complex',
        description: '简单任务',
        input: {},
      };

      const subtasks = await splitter.splitTask(task);
      
      // Should return at least one subtask or handle gracefully
      expect(Array.isArray(subtasks)).toBe(true);
    });

    it('should handle very large input arrays', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
      
      const task: Task = {
        id: 'task_011',
        type: 'complex',
        description: '处理大量数据',
        input: {
          items: largeArray,
          batchSize: 100,
        },
      };

      const subtasks = await splitter.splitTask(task);
      
      expect(subtasks.length).toBe(10); // 1000 / 100 = 10
    });
  });
});
