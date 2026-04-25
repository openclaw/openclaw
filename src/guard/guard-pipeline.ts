/**
 * OpenClaw 安全防护模块 — 防护管线 (入口)
 * 
 * 位置: src/guard/guard-pipeline.ts
 * 作用: 统一调度输入拦截 + 输出过滤 + 记忆管控，对外暴露单一接口
 * 
 * 使用方式:
 *   import { GuardPipeline } from './guard/guard-pipeline';
 *   const guard = new GuardPipeline();
 *   const result = await guard.checkInput(userInput);
 *   if (result.blocked) { return result.response; }
 *   const output = await agent.process(userInput);
 *   const safe = guard.sanitizeOutput(output);
 */

import { InputGuard } from './input-guard';
import { OutputGuard } from './output-guard';
import { MemoryGuard } from './memory-guard';
import { SkillAuditor } from './skill-audit';

export interface PipelineInputResult {
  blocked: boolean;
  response?: string;
  layer: 'rule' | 'semantic' | 'llm' | 'none';
  ruleId?: string;
  category?: string;
}

export interface PipelineOutputResult {
  sanitized: string;
  leaked: boolean;
  leakScore: number;
}

export class GuardPipeline {
  private inputGuard: InputGuard;
  private outputGuard: OutputGuard;
  private memoryGuard: MemoryGuard;
  private skillAuditor: SkillAuditor;

  constructor(protectedTexts: string[] = []) {
    this.inputGuard = new InputGuard();
    this.outputGuard = new OutputGuard(protectedTexts);
    this.memoryGuard = new MemoryGuard();
    this.skillAuditor = new SkillAuditor();
  }

  // ===== 输入检查 =====

  checkInput(input: string): PipelineInputResult {
    // Level 1: 规则匹配 (~1ms)
    const ruleResult = this.inputGuard.check(input);
    if (ruleResult.blocked) {
      this.auditLog('rule', ruleResult.rule?.id, ruleResult.rule?.category, input);
      return {
        blocked: true,
        response: ruleResult.response,
        layer: 'rule',
        ruleId: ruleResult.rule?.id,
        category: ruleResult.rule?.category,
      };
    }

    // Level 2/3 (语义/LLM) 预留接口，后续接入
    // 当 ruleResult.allMatches 有 warn 但未 block 时，可触发语义检测

    return { blocked: false, layer: 'none' };
  }

  // ===== 输出过滤 =====

  sanitizeOutput(output: string): PipelineOutputResult {
    return this.outputGuard.sanitize(output);
  }

  // ===== 记忆访问控制 =====

  checkFileAccess(filePath: string, accessor: 'user' | 'agent' | 'admin', level: 0 | 1 | 2) {
    return this.memoryGuard.checkFileAccess(filePath, accessor, level);
  }

  validateMemoryWrite(content: string) {
    return this.memoryGuard.validateWrite(content);
  }

  // ===== Skill 审计 =====

  auditSkill(skillMd: string, scripts: { filename: string; content: string }[]) {
    return this.skillAuditor.audit(skillMd, scripts);
  }

  // ===== 审计日志 =====

  private auditLog(layer: string, ruleId?: string, category?: string, input?: string) {
    const entry = {
      event: 'guard_block',
      timestamp: new Date().toISOString(),
      layer,
      ruleId,
      category,
      inputLength: input?.length || 0,
      inputHash: input ? this.simpleHash(input) : undefined,
    };

    // 生产环境: 写入 SLS / 文件
    // 开发环境: console
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Guard]', JSON.stringify(entry));
    }

    // TODO: 接入阿里云 SLS
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }
}
