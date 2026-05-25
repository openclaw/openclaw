$sub = "12561c86-6070-4d32-998a-71834ff653d1"
$rg = "rrg-dev"
$name = "azocggtunnpdilgmg2"
$rev = "azocggtunnpdilgmg2--azd-1777657307"
$replica = "azocggtunnpdilgmg2--azd-1777657307-544945cd57-kpvnh"
$container = "openclaw"
$tokenJson = az rest --method post --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.App/containerApps/$name/getAuthToken?api-version=2025-01-01"
$token = ($tokenJson | ConvertFrom-Json).properties.token
$wsUrl = "wss://westeurope.azurecontainerapps.dev/subscriptions/$sub/resourceGroups/$rg/containerApps/$name/revisions/$rev/replicas/$replica/containers/$container/exec?command=sh%20-lc%20%27echo%20ACA-EXEC-OK%27"
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.SetRequestHeader("Authorization", "Bearer $token")
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(20000)
try {
    $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 4096
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $segment = New-Object ArraySegment[byte] -ArgumentList @(,$buffer)
        $result = $ws.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
        if ($result.MessageType -eq 'Close') {
            Write-Output "WS Closed: $($result.CloseStatus)"
            break
        }
        $msg = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        Write-Output "WS Data: $msg"
        if ($msg -match "ACA-EXEC-OK") { break }
    }
} catch {
    Write-Output "Error: $($_.Exception.Message)"
} finally {
    $ws.Dispose()
}
$sub = "12561c86-6070-4d32-998a-71834ff653d1"
$rg = "rrg-dev"
$name = "azocggtunnpdilgmg2"
$rev = "azocggtunnpdilgmg2--azd-1777657307"
$replica = "azocggtunnpdilgmg2--azd-1777657307-544945cd57-kpvnh"
$container = "openclaw"
$tokenJson = az rest --method post --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.App/containerApps/$name/getAuthToken?api-version=2025-01-01"
$token = ($tokenJson | ConvertFrom-Json).properties.token
$wsUrl = "wss://westeurope.azurecontainerapps.dev/subscriptions/$sub/resourceGroups/$rg/containerApps/$name/revisions/$rev/replicas/$replica/containers/$container/exec?command=sh%20-lc%20%27echo%20ACA-EXEC-OK%27"
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.SetRequestHeader(\"Authorization\", \"Bearer $token\")
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(20000)
try {
    $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 4096
    while ($ws.State -eq 'Open') {
        $segment = New-Object ArraySegment[byte] -ArgumentList @(,$buffer)
        $result = $ws.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
        if ($result.MessageType -eq 'Close') { Write-Host 'Closed'; break }
        $msg = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        Write-Host "Data: $msg"
        if ($msg -match 'ACA-EXEC-OK') { break }
    }
} catch { Write-Host "Error: $($_.Exception.Message)" } finally { $ws.Dispose() }
