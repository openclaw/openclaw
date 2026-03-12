# Send complex message to OpenClaw Gateway via WebSocket
param(
    [string]$message = "Please help me write a JavaScript function that calculates fibonacci numbers with memoization.",
    [string]$port = "19001"
)

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$endpoint = "ws://127.0.0.1:$port/"

Write-Host "=== Connecting to OpenClaw Gateway ===" -ForegroundColor Cyan
$ws.ConnectAsync($endpoint, $ct).Wait()

# Receive challenge
$buffer = [byte[]]::new(8192)
$receiveTask = $ws.ReceiveAsync($buffer, $ct)
$receiveTask.Wait()
$result = $receiveTask.Result
$challengeText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
$challenge = $challengeText | ConvertFrom-Json
Write-Host "Received challenge: $($challenge.event)" -ForegroundColor Yellow

if ($challenge.event -eq "connect.challenge") {
    Write-Host "Sending auth response with token..." -ForegroundColor Yellow
    # Use environment variable or placeholder
    $token = if ($env:OPENCLAW_GATEWAY_TOKEN) { $env:OPENCLAW_GATEWAY_TOKEN } else { "test-token-placeholder" }
    $authResponse = @{
        type = "auth"
        method = "token"
        token = $token
        nonce = $challenge.payload.nonce
    } | ConvertTo-Json -Compress

    $ws.SendAsync([ArraySegment[byte]][System.Text.Encoding]::UTF8.GetBytes($authResponse), 'Text', $true, $ct).Wait()
    Write-Host "Auth sent" -ForegroundColor Green
}

# Wait for auth result
$buffer = [byte[]]::new(4096)
$receiveTask = $ws.ReceiveAsync($buffer, $ct)
$receiveTask.Wait()
$result = $receiveTask.Result
$authText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
$auth = $authText | ConvertFrom-Json
Write-Host "Auth result: $($auth.event)" -ForegroundColor Yellow

if ($auth.event -eq "connect.success") {
    Write-Host "=== Authenticated Successfully! ===" -ForegroundColor Green

    Write-Host "`nSending complex message: $message" -ForegroundColor Cyan

    $chatRequest = @{
        id = "complex-test-$(Get-Random)"
        method = "agent"
        params = @{
            message = $message
            sessionKey = "main"
        }
    } | ConvertTo-Json -Compress

    $ws.SendAsync([ArraySegment[byte]][System.Text.Encoding]::UTF8.GetBytes($chatRequest), 'Text', $true, $ct).Wait()
    Write-Host "Message sent, waiting for response..." -ForegroundColor Green

    # Collect all responses
    $fullResponse = ""
    $timeout = 120
    $elapsed = 0

    while ($elapsed -lt $timeout -and $ws.State -eq 'Open') {
        $buffer = [byte[]]::new(8192)
        $receiveTask = $ws.ReceiveAsync($buffer, $ct)

        if ($receiveTask.Wait(1000)) {
            $result = $receiveTask.Result
            $responseText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
            $resp = $responseText | ConvertFrom-Json

            # Handle streaming
            if ($resp.state -eq "delta" -or $resp.state -eq "partial") {
                if ($resp.message -and $resp.message.content) {
                    $content = $resp.message.content[0].text
                    if ($content) {
                        Write-Host "." -NoNewline
                        $fullResponse += $content
                    }
                }
            }

            # Final response
            if ($resp.state -eq "final" -or $resp.event -eq "agent.stop") {
                Write-Host "`n`n=== Received Final Response ===" -ForegroundColor Green
                Write-Host $fullResponse
                break
            }

            # Error
            if ($resp.error) {
                Write-Host "`nERROR: $($resp.error)" -ForegroundColor Red
                break
            }
        }
        $elapsed++
    }

    if ($fullResponse) {
        Write-Host "`n=== SUCCESS: Complex message delivered and response received ===" -ForegroundColor Green
    } else {
        Write-Host "`n=== FAILED: No response received within timeout ===" -ForegroundColor Red
    }
} elseif ($auth.event -eq "connect.error") {
    Write-Host "Auth FAILED: $($auth.error)" -ForegroundColor Red
}

$ws.CloseAsync('NormalClosure', "", $ct).Wait()
Write-Host "Connection closed"
