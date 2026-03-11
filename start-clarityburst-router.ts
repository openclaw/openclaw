#!/usr/bin/env node

/**
 * ClarityBurst Router Service - Local Development Server
 * 
 * This is a lightweight HTTP server that implements the ClarityBurst routing
 * API contract for local development and testing.
 * 
 * Port: 3001 (default CLARITYBURST_ROUTER_URL)
 * Endpoint: POST /api/route
 */

import http from 'node:http';
import { URL } from 'node:url';

interface RouteRequest {
  stageId: string;
  packId: string;
  packVersion: string;
  allowedContractIds: string[];
  userText: string;
  context?: Record<string, unknown>;
}

interface RouteResponse {
  top1: { contract_id: string; score: number };
  top2: { contract_id: string; score: number };
  router_version?: string;
}

// Route decision logic - allows all by default in dev mode
function makeRoutingDecision(request: RouteRequest): RouteResponse {
  const { allowedContractIds } = request;
  
  if (!allowedContractIds || allowedContractIds.length === 0) {
    return {
      top1: { contract_id: 'default_allow', score: 0.95 },
      top2: { contract_id: 'default_abstain', score: 0.05 },
      router_version: '1.0.0-dev',
    };
  }

  // Return first two contracts from allowed list
  const top1 = allowedContractIds[0];
  const top2 = allowedContractIds[1] || 'default_abstain';

  return {
    top1: { contract_id: top1, score: 0.95 },
    top2: { contract_id: top2, score: 0.05 },
    router_version: '1.0.0-dev',
  };
}

const PORT = parseInt(process.env.CLARITYBURST_ROUTER_PORT || '3001', 10);

const server = http.createServer(async (req, res) => {
  // Enable CORS for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', router: 'clarityburst-dev', uptime: process.uptime() }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  
  if (url.pathname !== '/api/route') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let body = '';
  
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const request: RouteRequest = JSON.parse(body);
      const response: RouteResponse = makeRoutingDecision(request);
      
      res.writeHead(200);
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request', details: String(err) }));
    }
  });

  req.on('error', (err) => {
    console.error('[router] Request error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Server error' }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n[ClarityBurst Router] listening on http://127.0.0.1:${PORT}`);
  console.log(`[ClarityBurst Router] Health check: http://127.0.0.1:${PORT}/health`);
  console.log(`[ClarityBurst Router] Routing endpoint: http://127.0.0.1:${PORT}/api/route`);
  console.log(`[ClarityBurst Router] Version: 1.0.0-dev\n`);
});

server.on('error', (err) => {
  console.error('[ClarityBurst Router] Server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n[ClarityBurst Router] Shutting down...');
  server.close(() => {
    console.log('[ClarityBurst Router] Stopped');
    process.exit(0);
  });
});
