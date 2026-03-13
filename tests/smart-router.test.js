/**
 * Smart Router Tests
 */

const assert = require('assert');
const { classifyRequest } = require('../lib/escalation-gate');
const { retrieve, store } = require('../lib/unified-memory');
const { createTrace, analyzeTraces } = require('../lib/trace-standard');

console.log('🧪 Running Smart Router Tests\n');

// Test 1: Classification
console.log('Test 1: Request Classification');
const ragReq = classifyRequest("What's my shopping list?");
assert.strictEqual(ragReq.level, 'rag', 'Should classify as RAG');
assert.strictEqual(ragReq.requiresAI, false, 'RAG should not require AI');
console.log('  ✅ RAG classification works');

const workflowReq = classifyRequest("Run backup now");
assert.strictEqual(workflowReq.level, 'workflow', 'Should classify as Workflow');
assert.strictEqual(workflowReq.requiresAI, false, 'Workflow should not require AI');
console.log('  ✅ Workflow classification works');

const agentReq = classifyRequest("Build a trading bot");
assert.strictEqual(agentReq.level, 'agent', 'Should classify as Agent');
assert.strictEqual(agentReq.requiresAI, true, 'Agent should require AI');
assert.ok(agentReq.justification, 'Agent should have justification');
console.log('  ✅ Agent classification works');

// Test 2: Unified Memory
console.log('\nTest 2: Unified Memory');
const testId = store('experiences', {
  title: 'Test Entry',
  content: 'This is a test for the unified memory system',
  importance: 8
});
assert.ok(testId, 'Should return entry ID');
console.log('  ✅ Store works');

const results = retrieve({ query: 'test unified memory', limit: 5 });
assert.ok(Array.isArray(results), 'Should return array');
assert.ok(results.length > 0, 'Should find at least one result');
console.log('  ✅ Retrieve works');

// Test 3: Trace Standard
console.log('\nTest 3: Trace Standard');
const trace = createTrace("Test request");
assert.ok(trace.id, 'Should have trace ID');
assert.ok(trace.data, 'Should have data');
console.log('  ✅ Trace creation works');

trace.logRouting({ level: 'rag', justification: 'Test' });
assert.strictEqual(trace.data.routing.level, 'rag', 'Should log routing');
console.log('  ✅ Routing logging works');

trace.logStep({ tool: 'test', latency: 100, success: true });
assert.strictEqual(trace.data.steps.length, 1, 'Should log step');
console.log('  ✅ Step logging works');

trace.logOutcome({ success: true, result: 'Test passed' });
assert.strictEqual(trace.data.outcome.success, true, 'Should log outcome');
console.log('  ✅ Outcome logging works');

// Test 4: Analytics
console.log('\nTest 4: Trace Analytics');
const analysis = analyzeTraces();
assert.ok(analysis.total >= 0, 'Should have total count');
assert.ok(analysis.byLevel, 'Should have level breakdown');
console.log('  ✅ Analytics works');

console.log('\n✅ All tests passed!');
