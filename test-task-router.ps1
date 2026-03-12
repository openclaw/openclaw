# Test Task Router
# This script tests the Task Router module

Write-Host "=== Testing Task Router ===" -ForegroundColor Cyan

# Test cases for each category (ASCII-safe)
$testCases = @(
    @{ message = "fix this bug"; expected = "code" },
    @{ message = "open Notepad app"; expected = "desktop" },
    @{ message = "search on Google for tutorial"; expected = "browser" },
    @{ message = "explain what is machine learning"; expected = "knowledge" },
    @{ message = "remind me to meeting at 8am daily"; expected = "automation" },
    @{ message = "write Python fibonacci function"; expected = "code" },
    @{ message = "close this window"; expected = "desktop" },
    @{ message = "login to Gmail"; expected = "browser" },
    @{ message = "summarize this article"; expected = "knowledge" },
    @{ message = "sync files to backup weekly"; expected = "automation" }
)

$passed = 0
$failed = 0

foreach ($test in $testCases) {
    Write-Host "`nTesting: $($test.message)" -ForegroundColor Yellow

    # Call task router via gateway - classify task type
    $result = pnpm openclaw agent --message "What type of task is this? Just answer: code, desktop, browser, knowledge, or automation. Task: $($test.message)" --session-id main 2>&1

    Write-Host "Expected: $($test.expected)"
    if ($result -match $test.expected) {
        Write-Host "Result: MATCH" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "Result: NO MATCH" -ForegroundColor Red
        $failed++
    }
}

Write-Host "`n=== Test Summary ===" -ForegroundColor Cyan
Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor Red
