$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument 'scripts/run-node.mjs gateway' -WorkingDirectory 'D:\openclaw'
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'OpenClaw Gateway' -Action $action -Trigger $trigger -Settings $settings -Description 'Auto-start OpenClaw gateway at login' -Force
