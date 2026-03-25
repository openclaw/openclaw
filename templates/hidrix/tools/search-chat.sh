#!/bin/bash
# Search chat history using grep
# Usage: ./search-chat.sh "query" [limit] [month]
#
# Examples:
#   ./search-chat.sh "n8n"           # Search all history for "n8n"
#   ./search-chat.sh "Giang" 10      # Find 10 results mentioning Giang
#   ./search-chat.sh "affiliate" 20 2026-03  # Search March 2026 only

QUERY="$1"
LIMIT="${2:-20}"
MONTH="$3"

if [ -z "$QUERY" ]; then
  echo "Usage: ./search-chat.sh \"query\" [limit] [month]"
  echo ""
  echo "Examples:"
  echo "  ./search-chat.sh \"n8n\"              # Search all"
  echo "  ./search-chat.sh \"Giang\" 10         # Limit 10 results"
  echo "  ./search-chat.sh \"AI\" 20 2026-03    # March 2026 only"
  exit 1
fi

# Chat history location
# Inside container: /workspace
# Outside container: ~/.agents/hidrix-community/workspace
if [ -d "/workspace/knowledge/chat-history" ]; then
  CHAT_DIR="/workspace/knowledge/chat-history"
elif [ -d "$HOME/.agents/hidrix-community/workspace/knowledge/chat-history" ]; then
  CHAT_DIR="$HOME/.agents/hidrix-community/workspace/knowledge/chat-history"
else
  CHAT_DIR="./knowledge/chat-history"
fi

if [ ! -d "$CHAT_DIR" ]; then
  echo "No chat history found at $CHAT_DIR"
  exit 1
fi

# Build file pattern
if [ -n "$MONTH" ]; then
  FILE_PATTERN="${MONTH}*.md"
else
  FILE_PATTERN="*.md"
fi

# Search with grep
RESULTS=$(grep -rni "$QUERY" "$CHAT_DIR" --include="$FILE_PATTERN" 2>/dev/null | head -n "$LIMIT")

if [ -z "$RESULTS" ]; then
  echo "No matches found for \"$QUERY\""
  exit 0
fi

# Count total matches
TOTAL=$(grep -rnic "$QUERY" "$CHAT_DIR" --include="$FILE_PATTERN" 2>/dev/null | awk -F: '{sum+=$2} END {print sum}')

echo "Found $TOTAL result(s) for \"$QUERY\" (showing first $LIMIT):"
echo ""

# Format output
echo "$RESULTS" | while IFS= read -r line; do
  # Extract filename and content
  FILE=$(echo "$line" | sed 's|.*/||' | cut -d: -f1)
  LINENUM=$(echo "$line" | cut -d: -f2)
  CONTENT=$(echo "$line" | cut -d: -f3-)
  echo "[$FILE:$LINENUM] $CONTENT"
done
