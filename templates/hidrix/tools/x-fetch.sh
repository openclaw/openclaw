#!/bin/bash
# Quick X/Twitter fetch using Supadata
# Usage: ./x-fetch.sh <tweet_url>

API_KEY=$(grep SUPADATA_API_KEY ~/hidrix/.env | cut -d= -f2)
URL="$1"

if [ -z "$URL" ]; then
  echo "Usage: ./x-fetch.sh <tweet_url>"
  exit 1
fi

# Fetch metadata
echo "=== Metadata ==="
curl -s "https://api.supadata.ai/v1/metadata?url=$URL" \
  -H "x-api-key: $API_KEY" | jq .

# If video, also fetch transcript
echo ""
echo "=== Transcript (if video) ==="
curl -s "https://api.supadata.ai/v1/transcript?url=$URL&text=true" \
  -H "x-api-key: $API_KEY" | jq .
