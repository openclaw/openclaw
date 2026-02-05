/**
 * Analytics Routes
 *
 * API endpoints for usage statistics and metrics.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  getCustomerUsageSummary,
  getAgentUsageSummary,
  getUsageTimeline,
  getRecentMessages,
} from '../../db/repositories/analytics-repository.js';

const router = Router();

// ============================================================================
// USAGE ANALYTICS
// ============================================================================

/**
 * Get usage summary
 * GET /api/v1/analytics/usage
 */
router.get('/usage', async (req, res) => {
  try {
    const period = z.enum(['hour', 'day', 'week', 'month']).parse(req.query.period || 'day');

    const summary = await getCustomerUsageSummary(req.customer!.id, period);

    res.json(summary);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Analytics] Usage error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get per-agent usage summary
 * GET /api/v1/analytics/agents
 */
router.get('/agents', async (req, res) => {
  try {
    const period = z.enum(['hour', 'day', 'week', 'month']).parse(req.query.period || 'day');

    const agents = await getAgentUsageSummary(req.customer!.id, period);

    res.json({ agents });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Analytics] Agents error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get usage timeline
 * GET /api/v1/analytics/timeline
 */
router.get('/timeline', async (req, res) => {
  try {
    const { period, granularity, agentId } = z
      .object({
        period: z.enum(['hour', 'day', 'week', 'month']).default('day'),
        granularity: z.enum(['hour', 'day']).default('hour'),
        agentId: z.string().uuid().optional(),
      })
      .parse(req.query);

    const timeline = await getUsageTimeline(
      req.customer!.id,
      agentId || null,
      period,
      granularity
    );

    res.json({ timeline });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Analytics] Timeline error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get recent messages
 * GET /api/v1/analytics/messages
 */
router.get('/messages', async (req, res) => {
  try {
    const { agentId, limit, offset } = z
      .object({
        agentId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const result = await getRecentMessages(req.customer!.id, { agentId, limit, offset });

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Analytics] Messages error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
