#!/bin/bash

echo "Testing cron RPC fix for issue #13018"
echo "======================================="

# Set up test environment
export OPENCLAW_ROOT="$HOME/.openclaw-test"
export OPENCLAW_DEBUG="gateway:*,cron:*"

echo ""
echo "1. Starting gateway with test config..."
./dist/index.js gateway start &
GATEWAY_PID=$!

echo "Waiting for gateway to start..."
sleep 3

echo ""
echo "2. Adding test cron jobs..."
for i in {1..15}; do
  ./dist/index.js cron add "test-job-$i" \
    --schedule "every 1h" \
    --message "Test job $i" || echo "Failed to add job $i"
done

echo ""
echo "3. Testing cron list (should complete within 10s)..."
time ./dist/index.js cron list

EXIT_CODE=$?

echo ""
echo "4. Cleaning up..."
kill $GATEWAY_PID 2>/dev/null
wait $GATEWAY_PID 2>/dev/null
rm -rf "$OPENCLAW_ROOT"

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ Test passed! Cron list completed successfully."
else
  echo ""
  echo "❌ Test failed! Cron list timed out or failed."
fi

exit $EXIT_CODE