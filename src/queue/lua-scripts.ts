/**
 * Atomic Dequeue Lua Script
 * Ensures message is removed from queue and marked as processing atomically
 */

export const ATOMIC_DEQUEUE_SCRIPT = `
local queueKey = KEYS[1]
local processingKey = KEYS[2]
local messageKeyPrefix = KEYS[3]
local timestamp = ARGV[1]

-- Get highest priority (lowest score) message
local result = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

if #result == 0 then
  return nil
end

-- Extract message ID and score
local msgId = result[1]
local score = result[2]

-- Atomically remove from queue (returns 1 if existed, 0 if not)
local removed = redis.call('ZREM', queueKey, msgId)

if removed == 0 then
  -- Already processed by another worker
  return nil
end

-- Mark as processing in stream
redis.call('XADD', processingKey, '*', 'messageId', msgId, 'status', 'processing', 'timestamp', timestamp)

-- Get message data
local fullMessageKey = messageKeyPrefix .. msgId
local msgData = redis.call('HGETALL', fullMessageKey)

if #msgData == 0 then
  -- Orphaned entry, clean it up
  return nil
end

-- Return message ID, score, and data
return {msgId, score, unpack(msgData)}
`;

/**
 * Clear Queue Lua Script (safe alternative to KEYS)
 */

export const CLEAR_QUEUE_SCRIPT = `
local queueKey = KEYS[1]
local messageKeyPrefix = KEYS[2]
local count = 0

-- Get all message IDs from queue
local messageIds = redis.call('ZRANGE', queueKey, 0, -1)

-- Delete message data for each message
for i, msgId in ipairs(messageIds) do
  local messageKey = messageKeyPrefix .. msgId
  redis.call('DEL', messageKey)
  count = count + 1
end

-- Clear the queue
redis.call('DEL', queueKey)

return count
`;
