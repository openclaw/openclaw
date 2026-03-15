# Session Routing Fix - 2026-03-15

## Problem
Chat responses were being routed to the wrong session. When a user:
1. Sends a message in Chat A
2. Switches to Chat B before the response arrives
3. Response from Chat A was either lost OR incorrectly shown in Chat B

**Root Cause:**
- `messages` state was global (single array for ALL sessions)
- `chatStream` state was also global
- When switching sessions, the old state was replaced with new session's history
- Event handler filtered events by `currentSessionKey`, causing responses from background sessions to be lost

## Solution
Changed from global state to **per-session state**:

### State Changes

**Before:**
```typescript
const [messages, setMessages] = useState<ChatMessage[]>([]);
const [chatStream, setChatStream] = useState<string | null>(null);
```

**After:**
```typescript
const [sessionMessages, setSessionMessages] = useState<Record<string, ChatMessage[]>>({});
const [sessionStreams, setSessionStreams] = useState<Record<string, string>>({});
```

### Key Changes

1. **Event Handler** - Now accumulates messages/streams to the correct session:
   ```typescript
   setSessionMessages((prev) => ({
     ...prev,
     [eventSessionKey]: [...(prev[eventSessionKey] ?? []), finalMsg],
   }));
   ```

2. **Render Logic** - Displays messages/streams for the currently selected session:
   ```typescript
   const currentMessages = selectedSessionKey ? (sessionMessages[selectedSessionKey] ?? []) : [];
   const currentStream = selectedSessionKey ? sessionStreams[selectedSessionKey] : undefined;
   ```

3. **All State Updates** - Updated to use per-session patterns:
   - `loadChatHistory()` - Loads into session-specific slot
   - `sendMessage()` - Adds user message to correct session
   - `handleClearChat()` - Clears only current session
   - `handleNewSession()` - Initializes new session slot
   - `handleDeleteSession()` - Cleans up session data
   - `addSystemMessage()` - Adds to current session
   - Command handlers - Use session-specific state

4. **Scroll Effect** - Triggers on sessionMessages/sessionStreams changes:
   ```typescript
   useEffect(() => {
     scrollToBottom();
   }, [sessionMessages, sessionStreams, selectedSessionKey, scrollToBottom]);
   ```

## Benefits

1. **No Cross-Session Leakage** - Each session maintains its own message history
2. **Background Responses Preserved** - Responses arrive in correct session even if user switched
3. **Cleaner State Management** - Session data is properly isolated
4. **Better UX** - Users can switch between conversations without losing context

## Files Modified

- `/Users/mac/Documents/openclaw/ui-next/app/chat/page.tsx`

## Testing

1. Open Chat A, send a message
2. Immediately switch to Chat B
3. Wait for response from Chat A
4. Switch back to Chat A - response should be there
5. Chat B should NOT have Chat A's response
